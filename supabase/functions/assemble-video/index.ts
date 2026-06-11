import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id } = await req.json();
    if (!script_id) {
      return new Response(JSON.stringify({ error: "script_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get script with parsed data
    const { data: script, error: scriptError } = await supabase
      .from("scripts")
      .select("id, title, writer_id, parsed_json")
      .eq("id", script_id)
      .single();

    if (scriptError || !script) {
      return new Response(
        JSON.stringify({ error: "Script not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get all Writer's Choice submissions
    const { data: submissions, error: subError } = await supabase
      .from("submissions")
      .select("*, character:characters(id, name)")
      .eq("script_id", script_id)
      .eq("is_writers_choice", true)
      .order("created_at");

    if (subError || !submissions || submissions.length === 0) {
      return new Response(
        JSON.stringify({ error: "No Writer's Choice submissions found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate signed URLs for each submission video
    const segments = [];
    for (const sub of submissions) {
      const { data: urlData } = await supabase.storage
        .from("submissions")
        .createSignedUrl(sub.video_url, 3600);

      if (urlData) {
        segments.push({
          url: urlData.signedUrl,
          character_name: (sub as any).character?.name || "Unknown",
          actor_id: sub.actor_id,
          submission_id: sub.id,
          order: segments.length,
        });
      }
    }

    // Get or create the assembled_reads record
    const { data: existingRead } = await supabase
      .from("assembled_reads")
      .select("id")
      .eq("script_id", script_id)
      .single();

    let assembledReadId: string;
    if (existingRead) {
      assembledReadId = existingRead.id;
      await supabase
        .from("assembled_reads")
        .update({ status: "processing" })
        .eq("id", assembledReadId);
    } else {
      const { data: newRead } = await supabase
        .from("assembled_reads")
        .insert({ script_id, status: "processing" })
        .select()
        .single();
      assembledReadId = newRead!.id;
    }

    // In production, this would POST to an external FFmpeg worker.
    // For MVP, we'll simulate assembly by marking it as ready
    // after a delay, since the external worker isn't deployed yet.
    //
    // When you deploy a video worker (e.g., on Railway/Fly.io),
    // uncomment the fetch below and set the WORKER_URL env var.

    const workerUrl = Deno.env.get("VIDEO_WORKER_URL");

    if (workerUrl) {
      // POST to external video worker
      try {
        await fetch(workerUrl + "/assemble", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assembled_read_id: assembledReadId,
            script_id,
            script_title: script.title,
            segments,
            callback_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/assemble-video`,
          }),
        });
      } catch (workerErr) {
        console.error("Worker dispatch failed:", workerErr);
        await supabase
          .from("assembled_reads")
          .update({ status: "failed" })
          .eq("id", assembledReadId);
      }
    } else {
      // MVP fallback: mark as ready after a brief delay (no actual video assembly)
      console.log(
        "No VIDEO_WORKER_URL configured. Marking assembly as ready (no video produced)."
      );
      await supabase
        .from("assembled_reads")
        .update({ status: "ready" })
        .eq("id", assembledReadId);

      // Update script status
      await supabase
        .from("scripts")
        .update({ status: "assembled" })
        .eq("id", script_id);

      // Notify the writer
      const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`;
      await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          user_id: script.writer_id,
          type: "assembly_ready",
          title: "Table Read Ready!",
          body: `Your table read for "${script.title}" has been assembled.`,
          data: { script_id, assembled_read_id: assembledReadId },
        }),
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        assembled_read_id: assembledReadId,
        segments_count: segments.length,
        worker_dispatched: !!workerUrl,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Assembly error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
