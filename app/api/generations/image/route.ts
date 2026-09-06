import { NextResponse } from "next/server";

import {
  findRecentHiggsfieldImage,
  isMockMode,
  publicError,
  submitHiggsfieldImage,
} from "@/lib/higgsfield";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { prompt?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (prompt.length < 3 || prompt.length > 4_000) {
      return NextResponse.json(
        { error: "Image prompt must be between 3 and 4,000 characters." },
        { status: 400 },
      );
    }

    if (isMockMode()) {
      return NextResponse.json({
        status: "queued",
        request_id: `demo-image-${Date.now()}`,
      });
    }

    const recent = await findRecentHiggsfieldImage(prompt, {
      signal: request.signal,
    });
    if (recent) return NextResponse.json(recent);

    const result = await submitHiggsfieldImage(prompt, {
      signal: request.signal,
    });

    return NextResponse.json(result);
  } catch (error) {
    const response = publicError(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
