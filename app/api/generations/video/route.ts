import { NextResponse } from "next/server";

import {
  findRecentHiggsfieldVideo,
  isMockMode,
  publicError,
  submitHiggsfieldVideo,
} from "@/lib/higgsfield";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: unknown;
      imageRequestId?: unknown;
      duration?: unknown;
      resolution?: unknown;
      cameraFixed?: unknown;
    };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const imageRequestId =
      typeof body.imageRequestId === "string" ? body.imageRequestId.trim() : "";
    const duration = Number(body.duration ?? 5);
    const resolution = body.resolution === "1080" ? "1080" : "720";

    if (prompt.length < 3 || prompt.length > 4_000) {
      return NextResponse.json(
        { error: "Motion prompt must be between 3 and 4,000 characters." },
        { status: 400 },
      );
    }

    if (!imageRequestId) {
      return NextResponse.json(
        { error: "A completed Higgsfield CLI first-frame job is required." },
        { status: 400 },
      );
    }

    if (!Number.isInteger(duration) || duration < 2 || duration > 12) {
      return NextResponse.json(
        { error: "Video duration must be between 2 and 12 seconds." },
        { status: 400 },
      );
    }

    if (isMockMode()) {
      return NextResponse.json({
        status: "queued",
        request_id: `demo-video-${Date.now()}`,
      });
    }

    const input = {
      prompt,
      imageRequestId,
      duration,
      resolution,
      cameraFixed: body.cameraFixed === true,
    } as const;
    const recent = await findRecentHiggsfieldVideo(input, {
      signal: request.signal,
    });
    if (recent) return NextResponse.json(recent);

    const result = await submitHiggsfieldVideo(input, {
      signal: request.signal,
    });

    return NextResponse.json(result);
  } catch (error) {
    const response = publicError(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
