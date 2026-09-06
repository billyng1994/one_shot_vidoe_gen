import { NextResponse } from "next/server";

import {
  getHiggsfieldCliHealth,
  getImageModel,
  getModelLabel,
  getVideoModel,
  isMockMode,
} from "@/lib/higgsfield";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("check") === "liveness") {
    return NextResponse.json({ ok: true });
  }

  const mockMode = isMockMode();
  const cli = await getHiggsfieldCliHealth();
  const imageModel = getImageModel();
  const videoModel = getVideoModel();

  return NextResponse.json({
    configured: mockMode || (cli.installed && cli.authenticated),
    mockMode,
    provider: "Higgsfield CLI",
    cli,
    models: {
      image: getModelLabel(imageModel),
      video: getModelLabel(videoModel),
    },
  });
}
