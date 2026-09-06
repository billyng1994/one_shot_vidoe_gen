import { NextResponse } from "next/server";

import {
  getHiggsfieldGeneration,
  isMockMode,
  publicError,
} from "@/lib/higgsfield";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;

  if (isMockMode() && requestId.startsWith("demo-image-")) {
    return NextResponse.json({
      status: "completed",
      request_id: requestId,
      images: [{ url: "/demo/demo-image.svg" }],
    });
  }

  if (isMockMode() && requestId.startsWith("demo-video-")) {
    return NextResponse.json({
      status: "completed",
      request_id: requestId,
      video: { url: "/demo/demo-video.mp4" },
    });
  }

  try {
    const result = await getHiggsfieldGeneration(requestId, {
      signal: _request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    const response = publicError(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
