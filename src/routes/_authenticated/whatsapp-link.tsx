import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Smartphone, Unlink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getWhatsAppLinkStatus, unlinkWhatsApp } from "@/lib/whatsapp.functions";

export const Route = createFileRoute("/_authenticated/whatsapp-link")({
  head: () => ({
    meta: [
      { title: "ربط واتساب | مثراء" },
      {
        name: "description",
        content: "ربط رقم واتساب بالنظام عبر رمز QR لإرسال التذكيرات مباشرة من الرقم.",
      },
      { property: "og:title", content: "ربط واتساب | مثراء" },
      {
        property: "og:description",
        content: "ربط رقم واتساب بالنظام عبر رمز QR لإرسال التذكيرات مباشرة من الرقم.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: WhatsAppLinkPage,
});

function WhatsAppLinkPage() {
  const qc = useQueryClient();
  const fetchStatus = useServerFn(getWhatsAppLinkStatus);
  const unlink = useServerFn(unlinkWhatsApp);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["whatsapp-link-status"],
    queryFn: async () => {
      try {
        return await fetchStatus();
      } catch (e) {
        return {
          configured: true,
          connection: "closed" as const,
          qr: null,
          me: null,
          error: `تعذر الوصول للخادم: ${(e as Error).message}`,
        };
      }
    },
    retry: false,
    refetchInterval: 5000,
  });

  const unlinkMutation = useMutation({
    mutationFn: () => unlink(),
    onSuccess: (res) => {
      if (res.ok) toast.success("تم فصل الرقم — امسح رمز QR جديد");
      else toast.error(res.error ?? "تعذر الفصل");
      void qc.invalidateQueries({ queryKey: ["whatsapp-link-status"] });
    },
  });

  const connected = data?.connection === "open";

  return (
    <div dir="rtl" className="mx-auto w-full max-w-3xl space-y-5 p-4 text-right md:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">ربط واتساب</h1>
        <p className="text-[13px] text-muted-foreground">
          اربط رقم واتساب مرة واحدة بمسح رمز QR، وبعدها كل زر «إرسال تذكير» يرسل الرسالة فورًا من
          نفس الرقم مجانًا.
        </p>
      </header>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> جارٍ التحقق من الحالة…
          </div>
        ) : !data?.configured ? (
          <div className="space-y-3 text-sm">
            <p className="font-semibold text-destructive">خدمة الربط غير مُفعّلة بعد</p>
            <p className="text-muted-foreground">
              أضف مفتاح خدمة واتساب <code>WHATSAPP_API_KEY</code> في إعدادات النظام، وبعدها سيظهر
              رمز QR هنا مباشرة.
            </p>
          </div>
        ) : connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Smartphone className="size-5" />
              </span>
              <div>
                <p className="font-semibold">الرقم مرتبط ويعمل</p>
                <p className="text-[13px] text-muted-foreground" dir="ltr">
                  {data.me ? `+${data.me}` : "—"}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => unlinkMutation.mutate()}
              disabled={unlinkMutation.isPending}
            >
              <Unlink className="me-2 size-4" /> فصل الرقم
            </Button>
          </div>
        ) : data.qr ? (
          <div className="space-y-4">
            <p className="text-sm font-semibold">امسح الرمز من تطبيق واتساب</p>
            <ol className="list-inside list-decimal space-y-1 text-[13px] text-muted-foreground">
              <li>افتح واتساب على الجوال</li>
              <li>الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</li>
              <li>وجّه الكاميرا على الرمز بالأسفل</li>
            </ol>
            <img
              src={data.qr}
              alt="رمز QR لربط رقم واتساب بالنظام"
              className="mx-auto size-64 rounded-lg border bg-white p-2"
            />
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> جارٍ تجهيز رمز QR…
            </div>
            {data.error ? <p className="text-[13px] text-destructive">{data.error}</p> : null}
          </div>
        )}

        <div className="mt-5 border-t pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["whatsapp-link-status"] })}
          >
            <RefreshCw className={`me-2 size-4 ${isFetching ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </div>
      </section>

      <p className="text-[12px] text-muted-foreground">
        ملاحظة: هذا ربط غير رسمي عبر واتساب ويب. إن انقطع الاتصال أو فشل الإرسال، يعود النظام
        تلقائيًا لاستخدام Twilio.
      </p>
    </div>
  );
}
