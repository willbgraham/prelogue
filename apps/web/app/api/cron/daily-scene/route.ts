// Daily cron (Vercel Cron → this route → the video worker's /daily). Vercel
// includes `Authorization: Bearer $CRON_SECRET` on scheduled invocations.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  }
  const worker = process.env.VIDEO_WORKER_URL;
  if (!worker) return new Response("VIDEO_WORKER_URL not set", { status: 500 });

  // Fire-and-forget: the worker does the multi-minute generate+render itself.
  await fetch(`${worker}/daily`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": secret ?? "" },
    body: "{}",
  }).catch(() => {});

  return new Response("daily scene triggered", { status: 200 });
}
