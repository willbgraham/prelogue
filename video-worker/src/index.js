const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const app = express();
app.use(express.json({ limit: "10mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.get("/health", (req, res) => {
  res.json({ status: "ok", ffmpeg: true, features: ["concat", "split-screen", "lower-thirds"] });
});

app.post("/assemble", async (req, res) => {
  const { assembled_read_id, script_id, script_title, segments, mode = "auto", scene_headings = [] } = req.body;

  if (!assembled_read_id || !segments?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ status: "processing", assembled_read_id });

  const tmpDir = path.join("/tmp", `assembly-${assembled_read_id}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`Assembling ${segments.length} segments (mode: ${mode}) for ${assembled_read_id}`);

    // 1. Download all segments
    const localPaths = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const localPath = path.join(tmpDir, `segment-${i}.mp4`);
      const response = await fetch(seg.url);
      if (!response.ok) throw new Error(`Failed to download segment ${i}`);
      const fileStream = fs.createWriteStream(localPath);
      await pipeline(response.body, fileStream);
      localPaths.push(localPath);
      console.log(`Downloaded segment ${i}: ${seg.character_name}`);
    }

    // 2. Normalize all videos
    const normalizedPaths = [];
    for (let i = 0; i < localPaths.length; i++) {
      const normalizedPath = path.join(tmpDir, `normalized-${i}.mp4`);
      await normalizeVideo(localPaths[i], normalizedPath);
      normalizedPaths.push(normalizedPath);
      console.log(`Normalized segment ${i}`);
    }

    // 3. Determine assembly mode
    const outputPath = path.join(tmpDir, "output.mp4");
    const uniqueChars = [...new Set(segments.map((s) => s.character_name))];
    const usesSplitScreen = mode === "split-screen" || (mode === "auto" && uniqueChars.length === 2);

    if (usesSplitScreen && normalizedPaths.length >= 2) {
      await assembleSplitScreen(normalizedPaths, segments, outputPath, tmpDir);
    } else {
      await assembleSequential(normalizedPaths, segments, outputPath, tmpDir, scene_headings);
    }

    console.log("Assembly complete, uploading...");

    // 4. Upload to Supabase Storage
    const storagePath = `${script_id}/${assembled_read_id}.mp4`;
    const fileBuffer = fs.readFileSync(outputPath);
    const { error: uploadError } = await supabase.storage
      .from("assembled-reads")
      .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw uploadError;

    // 5. Get public URL and update records
    const { data: { publicUrl } } = supabase.storage.from("assembled-reads").getPublicUrl(storagePath);

    await supabase.from("assembled_reads")
      .update({ status: "ready", video_url: publicUrl })
      .eq("id", assembled_read_id);

    await supabase.from("scripts")
      .update({ status: "assembled" })
      .eq("id", script_id);

    // 6. Notify writer
    const { data: script } = await supabase
      .from("scripts")
      .select("writer_id, title")
      .eq("id", script_id)
      .single();

    if (script) {
      await supabase.from("notifications").insert({
        user_id: script.writer_id,
        type: "assembly_ready",
        payload: {
          title: "Table Read Ready!",
          body: `Your table read for "${script.title}" has been assembled.`,
          script_id,
          assembled_read_id,
        },
      });
    }

    console.log(`Assembly complete for ${assembled_read_id}`);
  } catch (err) {
    console.error("Assembly failed:", err);
    await supabase.from("assembled_reads")
      .update({ status: "failed" })
      .eq("id", assembled_read_id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Normalize video to standard resolution, fps, and codecs.
 */
function normalizeVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-ar", "44100",
        "-ac", "2",
        "-shortest",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

/**
 * Generate a scene heading title card (e.g., "INT. COFFEE SHOP — DAY").
 * Creates a 3-second black video with centered white text.
 */
async function generateTitleCard(heading, outputPath) {
  return new Promise((resolve, reject) => {
    const safeText = heading.replace(/'/g, "\\'").replace(/"/g, '\\"');
    ffmpeg()
      .input("color=c=black:s=1080x1920:d=3")
      .inputOptions(["-f", "lavfi"])
      .input("anullsrc=r=44100:cl=stereo")
      .inputOptions(["-f", "lavfi", "-t", "3"])
      .outputOptions([
        "-vf",
        `drawtext=text='${safeText}':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:borderw=1:bordercolor=gray`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-shortest",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

/**
 * Sequential assembly with scene heading title cards and character name lower-thirds.
 */
async function assembleSequential(normalizedPaths, segments, outputPath, tmpDir, sceneHeadings = []) {
  // Add lower-third text overlay to each segment
  const overlaidPaths = [];
  for (let i = 0; i < normalizedPaths.length; i++) {
    const overlaidPath = path.join(tmpDir, `overlaid-${i}.mp4`);
    const charName = segments[i].character_name || "Unknown";

    await new Promise((resolve, reject) => {
      ffmpeg(normalizedPaths[i])
        .outputOptions([
          "-vf",
          `drawtext=text='${charName.replace(/'/g, "\\'")}':fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-100:enable='lt(t,4)'`,
          "-c:v", "libx264",
          "-preset", "fast",
          "-c:a", "copy",
        ])
        .output(overlaidPath)
        .on("end", resolve)
        .on("error", () => {
          // Fallback without overlay if drawtext fails
          fs.copyFileSync(normalizedPaths[i], overlaidPath);
          resolve();
        })
        .run();
    });
    overlaidPaths.push(overlaidPath);
  }

  // Generate scene heading title cards and intersperse
  const allPaths = [];
  for (let i = 0; i < overlaidPaths.length; i++) {
    // Check if this segment has a scene heading to show before it
    const seg = segments[i];
    const heading = sceneHeadings.find((h) => h.index === i);
    if (heading) {
      try {
        const titlePath = path.join(tmpDir, `title-${i}.mp4`);
        await generateTitleCard(heading.text, titlePath);
        allPaths.push(titlePath);
        console.log(`Generated title card: ${heading.text}`);
      } catch (err) {
        console.warn(`Title card failed for "${heading.text}", skipping`);
      }
    }
    allPaths.push(overlaidPaths[i]);
  }

  // Concatenate
  const concatFile = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(concatFile, allPaths.map((p) => `file '${p}'`).join("\n"));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c:v", "libx264", "-preset", "fast", "-c:a", "aac"])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

/**
 * Split-screen assembly: side-by-side talking heads.
 * Uses hstack filter to place two speakers side by side.
 */
async function assembleSplitScreen(normalizedPaths, segments, outputPath, tmpDir) {
  if (normalizedPaths.length < 2) {
    return assembleSequential(normalizedPaths, segments, outputPath, tmpDir);
  }

  // Scale each to half-width for side-by-side
  const halfPaths = [];
  for (let i = 0; i < normalizedPaths.length; i++) {
    const halfPath = path.join(tmpDir, `half-${i}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(normalizedPaths[i])
        .outputOptions([
          "-vf", "scale=540:1920",
          "-c:v", "libx264",
          "-preset", "fast",
          "-c:a", "aac",
        ])
        .output(halfPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    halfPaths.push(halfPath);
  }

  // Combine pairs into split-screen segments
  const splitPaths = [];
  for (let i = 0; i < halfPaths.length - 1; i += 2) {
    const splitPath = path.join(tmpDir, `split-${i}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(halfPaths[i])
        .input(halfPaths[i + 1])
        .complexFilter([
          "[0:v]setpts=PTS-STARTPTS[left]",
          "[1:v]setpts=PTS-STARTPTS[right]",
          "[left][right]hstack=inputs=2[v]",
          "[0:a][1:a]amix=inputs=2:duration=shortest[a]",
        ])
        .outputOptions([
          "-map", "[v]",
          "-map", "[a]",
          "-c:v", "libx264",
          "-preset", "fast",
          "-shortest",
        ])
        .output(splitPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    splitPaths.push(splitPath);
  }

  // If odd number of segments, add last one as full-width
  if (halfPaths.length % 2 !== 0) {
    splitPaths.push(normalizedPaths[normalizedPaths.length - 1]);
  }

  // Concatenate split-screen segments
  const concatFile = path.join(tmpDir, "concat-split.txt");
  fs.writeFileSync(concatFile, splitPaths.map((p) => `file '${p}'`).join("\n"));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c:v", "libx264", "-preset", "fast", "-c:a", "aac"])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

app.listen(PORT, () => {
  console.log(`Video worker listening on port ${PORT}`);
});
