import { NextResponse } from "next/server";
import { sendMeshMessage } from "@/lib/gateway/mesh-router";

// POST /api/mesh/send - Dispatch an inter-session / cross-host message
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      target: string;
      message: string;
      mode?: "followup" | "steer" | "silent";
      currentDeviceId?: string;
      senderContext?: {
        deviceId?: string;
        sessionId?: string;
        cwd?: string;
      };
    };

    console.log("[/api/mesh/send] Received request:", JSON.stringify(body));

    if (!body.target || typeof body.target !== "string") {
      return NextResponse.json({ error: "target is required" }, { status: 400 });
    }
    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const result = await sendMeshMessage({
      target: body.target,
      message: body.message,
      mode: body.mode || "followup",
      currentDeviceId: body.currentDeviceId,
      senderContext: body.senderContext,
    });

    console.log("[/api/mesh/send] Result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/mesh/send] Error details:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
