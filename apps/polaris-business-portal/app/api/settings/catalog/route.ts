import { NextResponse } from "next/server";
import { loadSettingsCatalog } from "@/lib/settings-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(loadSettingsCatalog());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
