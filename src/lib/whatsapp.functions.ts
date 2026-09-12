import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * إرسال واتساب عبر Evolution API (instance مستقلة لهذا الموقع).
 * الأسرار: WHATSAPP_API_URL + WHATSAPP_API_KEY + WHATSAPP_INSTANCE
 * ويبقى Twilio كخيار احتياطي إن توفرت بياناته.
 */

/** يحوّل رقمًا سعوديًا محليًا (05xxxxxxxx) إلى صيغة +966xxxxxxxx. */
export function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00966")) return `+${digits.slice(2)}`;
  if (digits.startsWith("966")) return `+${digits}`;
  if (digits.startsWith("05")) return `+966${digits.slice(1)}`;
  if (digits.startsWith("5") && digits.length === 9) return `+966${digits}`;
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

type TwilioResult =
  | { ok: true; sid: string }
  | { ok: false; error: string; needsTemplate?: boolean };

function clean(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^[A-Z_]+\s*=\s*/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function evoConfig() {
  const url = clean(process.env["WHATSAPP_API_URL"]).replace(/\/+$/, "");
  const key = clean(process.env["WHATSAPP_API_KEY"]);
  const instance = clean(process.env["WHATSAPP_INSTANCE"]) || "mithra2";
  return { url, key, instance };
}

async function evoFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; data: any; text: string }> {
  const { url, key } = evoConfig();
  const { json, ...rest } = init;
  const res = await fetch(`${url}${path}`, {
    ...rest,
    headers: {
      apikey: key,
      "Content-Type": "application/json",
      ...(rest.headers as Record<string, string> | undefined),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text().catch(() => "");
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

/** ينشئ الـ instance إن لم تكن موجودة. */
async function cloudEnsureInstance(): Promise<void> {
  const { instance } = evoConfig();
  const state = await evoFetch(`/instance/connectionState/${instance}`);
  if (state.status === 200) return;
  await evoFetch(`/instance/create`, {
    method: "POST",
    json: { instanceName: instance, integration: "WHATSAPP-BAILEYS", qrcode: true },
  });
}

function evoNumber(raw: string): string {
  return toE164(raw).replace(/^\+/, "");
}

async function evoSend(to: string, body: string): Promise<TwilioResult | null> {
  const { url, key, instance } = evoConfig();
  if (!url || !key) return null;
  try {
    await cloudEnsureInstance();
    const number = evoNumber(to);
    let res = await evoFetch(`/message/sendText/${instance}`, {
      method: "POST",
      json: { number, text: body },
    });
    if (res.status >= 400) {
      // توافق مع الإصدارات الأقدم من Evolution
      res = await evoFetch(`/message/sendText/${instance}`, {
        method: "POST",
        json: { number, textMessage: { text: body } },
      });
    }
    if (res.status < 400) {
      const id = res.data?.key?.id ?? res.data?.messageId ?? "";
      return { ok: true, sid: String(id) };
    }
    const msg =
      res.status === 401 || res.status === 403
        ? "مفتاح خدمة واتساب غير صحيح"
        : (res.data?.message ?? res.data?.error ?? res.text.slice(0, 200) ?? `Evolution ${res.status}`);
    return { ok: false, error: String(msg) };
  } catch (e) {
    return { ok: false, error: `تعذر الاتصال بخدمة واتساب: ${(e as Error).message}` };
  }
}

export async function twilioSend(input: {
  to: string;
  body: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
}): Promise<TwilioResult> {
  // الأولوية لخدمة واتساب الخاصة بنا (Evolution)، وإن فشلت نرجع لـTwilio.
  if (!input.contentSid) {
    const viaEvo = await evoSend(input.to, input.body);
    if (viaEvo?.ok) return viaEvo;
  }

  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_WHATSAPP_FROM"] ?? "whatsapp:+17372212163";
  if (!sid || !token) return { ok: false, error: "خدمة واتساب غير مرتبطة — امسح رمز QR من صفحة ربط واتساب" };

  const to = toE164(input.to);
  if (!to.startsWith("+") || to.length < 8) {
    return { ok: false, error: `رقم الجوال غير صالح: ${input.to}` };
  }

  const form = new URLSearchParams({ To: `whatsapp:${to}`, From: from });
  if (input.contentSid) {
    form.set("ContentSid", input.contentSid);
    if (input.contentVariables) form.set("ContentVariables", JSON.stringify(input.contentVariables));
  } else {
    form.set("Body", input.body);
  }

  let res: Response;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } catch (e) {
    return { ok: false, error: `تعذر الاتصال بـ Twilio: ${(e as Error).message}` };
  }

  if (res.ok) {
    const data = (await res.json()) as { sid?: string };
    return { ok: true, sid: data.sid ?? "" };
  }

  const text = await res.text();
  let message = `Twilio ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { message?: string; code?: number };
    if (parsed.message) message = `Twilio ${parsed.code ?? res.status}: ${parsed.message}`;
    if (parsed.code === 63016) {
      return {
        ok: false,
        needsTemplate: true,
        error: "العميل خارج نافذة الـ24 ساعة — يلزم قالب واتساب معتمد لهذه الرسالة",
      };
    }
  } catch {
    message = `Twilio ${res.status}: ${text.slice(0, 200)}`;
  }
  return { ok: false, error: message };
}

export const sendWhatsAppMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: unknown) =>
      z
        .object({
          to: z.string().min(5),
          body: z.string().min(1),
        })
        .parse(input),
  )
  .handler(async ({ data }): Promise<TwilioResult> => {
    const { requireUnlocked } = await import("@/lib/kill-switch.server");
    await requireUnlocked();
    const result = await twilioSend({ to: data.to, body: data.body });
    const { dispatchAutomation } = await import("@/lib/automation.server");
    await dispatchAutomation("whatsapp.sent", {
      to: data.to,
      body: data.body,
      ok: result.ok,
      sid: result.ok ? result.sid : null,
      error: result.ok ? null : result.error,
    });
    return result;
  });

export const checkTwilioConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { url, key } = evoConfig();
    return {
      configured: Boolean(url && key) || Boolean(process.env["TWILIO_ACCOUNT_SID"] && process.env["TWILIO_AUTH_TOKEN"]),
      from: process.env["TWILIO_WHATSAPP_FROM"] ?? null,
    };
  });

/** حالة ربط واتساب + رمز QR للمسح عبر Evolution API. */
export const getWhatsAppLinkStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { url, key, instance } = evoConfig();
    if (!url || !key) {
      return { configured: false, connection: "closed" as const, qr: null, me: null, error: null };
    }
    try {
      await cloudEnsureInstance();

      const state = await evoFetch(`/instance/connectionState/${instance}`);
      if (state.status === 401 || state.status === 403) {
        return {
          configured: true,
          connection: "closed" as const,
          qr: null,
          me: null,
          error: "مفتاح خدمة واتساب غير صحيح — راجع قيمة WHATSAPP_API_KEY",
        };
      }
      const raw = String(state.data?.instance?.state ?? state.data?.state ?? "close");
      if (raw === "open") {
        const list = await evoFetch(`/instance/fetchInstances?instanceName=${instance}`);
        const first = Array.isArray(list.data) ? list.data[0] : null;
        const owner: string | null =
          first?.instance?.owner ?? first?.ownerJid ?? first?.instance?.profileName ?? null;
        return {
          configured: true,
          connection: "open" as const,
          qr: null,
          me: owner ? String(owner).split("@")[0]! : null,
          error: null,
        };
      }

      const connect = await evoFetch(`/instance/connect/${instance}`);
      const base64: string | null = connect.data?.base64 ?? connect.data?.qrcode?.base64 ?? null;
      const qr = base64 ? (base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`) : null;
      return {
        configured: true,
        connection: (raw === "connecting" ? "connecting" : "closed") as "connecting" | "closed",
        qr,
        me: null,
        error: qr ? null : (connect.data?.message ?? null),
      };
    } catch (e) {
      return {
        configured: true,
        connection: "closed" as const,
        qr: null,
        me: null,
        error: `تعذر الوصول لخدمة واتساب: ${(e as Error).message}`,
      };
    }
  });

/** فصل الرقم المرتبط وإظهار رمز QR جديد. */
export const unlinkWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { url, key, instance } = evoConfig();
    if (!url || !key) return { ok: false, error: "خدمة واتساب غير مُعدّة" };
    try {
      const res = await evoFetch(`/instance/logout/${instance}`, { method: "DELETE" });
      return { ok: res.status < 400, error: res.status < 400 ? null : `Evolution ${res.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
