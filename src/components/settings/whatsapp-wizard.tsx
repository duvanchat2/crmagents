"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Provider = "meta" | "kapso";

type Connection = {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: "connected" | "reconnect_required";
  provider: Provider;
  tokenLast4: string | null;
};

type Transport = { provider: Provider; apiKeyLast4: string | null };

const PROVIDER_LABEL: Record<Provider, string> = { meta: "Meta", kapso: "Kapso" };

type WebhookInfo = {
  url: string;
  verifyToken: string;
  isHttps: boolean;
  signatureLayer: boolean;
};

export function WhatsappWizard() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [transport, setTransport] = useState<Transport>({
    provider: "meta",
    apiKeyLast4: null,
  });
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const [c, w] = await Promise.all([
      fetch("/api/settings/whatsapp").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/settings/webhook").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null]);
    if (c) {
      setConnection(c.connection);
      setTransport({ provider: c.provider ?? "meta", apiKeyLast4: c.apiKeyLast4 ?? null });
    }
    if (w) setWebhook(w);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const providerMismatch =
    connection !== null && connection.provider !== transport.provider;

  return (
    <div className="max-w-3xl space-y-6">
      {providerMismatch && connection && (
        <div className="flex items-start gap-2 rounded-lg border border-[#ece2cf] bg-[#faf7f0] p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8a6d3b]" />
          <div>
            <p className="font-medium text-[#8a6d3b]">
              La conexión guardada es de {PROVIDER_LABEL[connection.provider]}, pero
              esta instancia usa {PROVIDER_LABEL[transport.provider]}.
            </p>
            <p className="text-[#8a6d3b]/80">
              Los envíos están pausados hasta que vuelvas a conectar el número abajo.
            </p>
          </div>
        </div>
      )}

      {!providerMismatch && connection?.status === "reconnect_required" && (
        <div className="flex items-start gap-2 rounded-lg border border-[#ecd4d2] bg-[#faf1f0] p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-[#a2504c]">
              El token de WhatsApp expiró o fue revocado.
            </p>
            <p className="text-[#a2504c]/80">
              Los envíos están pausados. Pega un token nuevo abajo y prueba la
              conexión para reconectar.
            </p>
          </div>
        </div>
      )}

      {connection && !providerMismatch && connection.status === "connected" && (
        <div className="flex items-center gap-3 rounded-lg border border-[#d8e8dd] bg-[#eff7f1] p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div className="flex-1 text-sm">
            <p className="font-medium text-[#3f6b52]">
              Número conectado: {connection.displayPhoneNumber ?? connection.phoneNumberId}
            </p>
            <p className="text-[#3f6b52]/80">
              {connection.verifiedName ? `${connection.verifiedName} · ` : ""}
              {connection.provider === "kapso"
                ? `vía Kapso · API key …${transport.apiKeyLast4 ?? "????"}`
                : `token …${connection.tokenLast4 ?? "????"}`}
            </p>
          </div>
          <Badge variant="success">Conectado</Badge>
        </div>
      )}

      <ConnectForm
        existing={connection}
        transport={transport}
        onSaved={() => void refetch()}
      />

      {webhook && <WebhookCard webhook={webhook} provider={transport.provider} />}
    </div>
  );
}

function ConnectForm({
  existing,
  transport,
  onSaved,
}: {
  existing: Connection | null;
  transport: Transport;
  onSaved: () => void;
}) {
  const isKapso = transport.provider === "kapso";
  const [wabaId, setWabaId] = useState(existing?.wabaId ?? "");
  const [phoneNumberId, setPhoneNumberId] = useState(
    existing?.phoneNumberId ?? ""
  );
  const [token, setToken] = useState("");
  const [testResult, setTestResult] = useState<
    | { ok: true; display: string }
    | { ok: false; message: string }
    | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // En Kapso no hay token por número y la WABA la informa Kapso al probar.
  const canTest = isKapso
    ? phoneNumberId.trim()
    : wabaId.trim() && phoneNumberId.trim() && token.trim();

  async function test() {
    setTesting(true);
    setTestResult(null);
    const res = await fetch("/api/settings/whatsapp/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isKapso ? { phoneNumberId } : { phoneNumberId, token }),
    }).catch(() => null);
    setTesting(false);
    if (!res) {
      setTestResult({ ok: false, message: "Sin conexión con el servidor" });
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      displayPhoneNumber?: string;
      wabaId?: string | null;
      error?: { message?: string };
    } | null;
    if (res.ok && data?.displayPhoneNumber) {
      if (data.wabaId) setWabaId(data.wabaId);
      setTestResult({ ok: true, display: data.displayPhoneNumber });
    } else {
      setTestResult({
        ok: false,
        message: data?.error?.message ?? "La validación falló",
      });
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    const res = await fetch("/api/settings/whatsapp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        isKapso ? { wabaId, phoneNumberId } : { wabaId, phoneNumberId, token }
      ),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setSaveError(data?.error?.message ?? "No se pudo guardar la conexión");
      return;
    }
    setToken("");
    setTestResult(null);
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {existing ? "Reconectar / actualizar el número" : "Conectar tu número de WhatsApp"}
        </CardTitle>
        <CardDescription>
          {isKapso
            ? `Esta instancia envía por Kapso con la API key de la instancia (…${transport.apiKeyLast4 ?? "????"}). Indica el Phone Number ID de un número ya conectado en app.kapso.ai: se valida contra tu cuenta de Kapso antes de guardarse.`
            : "Pega las credenciales de WhatsApp Cloud API. El token se valida contra Meta ANTES de guardarse y se almacena cifrado."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isKapso && (
        <div className="grid gap-3 rounded-md border bg-background/40 p-4 text-sm">
          <p className="font-medium">¿De dónde sale el token?</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="mb-1 font-medium text-primary">Modo directo</p>
              <p className="text-muted-foreground">
                El negocio tiene su propia app en{" "}
                <span className="text-foreground">developers.facebook.com</span>:
                usa un token de <span className="text-foreground">usuario del sistema</span>{" "}
                (no expira) con permisos de WhatsApp. En este modo conviene
                configurar también el App Secret para la firma del webhook.
              </p>
            </div>
            <div className="rounded-md border p-3">
              <p className="mb-1 font-medium text-primary">Modo agencia (Tech Provider)</p>
              <p className="text-muted-foreground">
                Tu agencia hace el Embedded Signup en SU plataforma y su
                backend obtiene el token del cliente; te lo entrega para
                pegarlo aquí. El webhook se conecta con el{" "}
                <span className="text-foreground">override por WABA</span>{" "}
                (checklist de 5 pasos en el README).
              </p>
            </div>
          </div>
        </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="waba-id">WABA ID</Label>
            <Input
              id="waba-id"
              placeholder={
                isKapso
                  ? "Se completa al probar la conexión"
                  : "ID de la cuenta de WhatsApp Business"
              }
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone-number-id">Phone Number ID</Label>
            <Input
              id="phone-number-id"
              placeholder="ID del número de teléfono"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
          </div>
        </div>
        {!isKapso && (
        <div className="space-y-1.5">
          <Label htmlFor="token">Token de acceso</Label>
          <Input
            id="token"
            type="password"
            placeholder={existing ? `Guardado (…${existing.tokenLast4}) — pega uno nuevo para cambiarlo` : "EAAG…"}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTestResult(null);
            }}
          />
        </div>
        )}

        {testResult && (
          <p
            className={`text-sm ${testResult.ok ? "text-success" : "text-destructive"}`}
          >
            {testResult.ok
              ? isKapso
                ? `✓ Número encontrado en Kapso: ${testResult.display}. Ya puedes guardar.`
                : `✓ Token válido para ${testResult.display}. Ya puedes guardar.`
              : testResult.message}
          </p>
        )}
        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!canTest || testing}
            onClick={() => void test()}
          >
            {testing ? "Probando…" : "Probar conexión"}
          </Button>
          <Button
            disabled={!testResult?.ok || saving}
            onClick={() => void save()}
          >
            {saving ? "Guardando…" : "Guardar conexión"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WebhookCard({
  webhook,
  provider,
}: {
  webhook: WebhookInfo;
  provider: Provider;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, which: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook de WhatsApp</CardTitle>
        <CardDescription>
          Pega estos valores en el panel de Meta (modo directo) o úsalos en el
          override de tu backend de agencia (a nivel WABA).{" "}
          <strong className="text-foreground">
            Guarda la conexión ANTES de configurar el webhook:
          </strong>{" "}
          la verificación (handshake) funciona sin guardar, pero los mensajes
          solo se reciben si la conexión está guardada — se enrutan por tu
          Phone Number ID.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {provider === "kapso" && (
          <p className="flex items-start gap-2 rounded-md border bg-background/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Modo Kapso: por ahora la instancia solo ENVÍA por Kapso. La
            recepción de mensajes vía webhook de Kapso (tipo &quot;meta&quot; hacia
            esta misma URL, con firma X-Webhook-Signature) llega en la
            siguiente entrega; no la registres todavía.
          </p>
        )}
        {!webhook.isHttps && (
          <p className="flex items-start gap-2 rounded-md border border-[#ece2cf] bg-[#faf7f0] p-3 text-xs text-[#8a6d3b]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            La URL configurada no es https: Meta exige https para los webhooks.
            Ajusta APP_BASE_URL con tu dominio público.
          </p>
        )}
        <div className="space-y-1.5">
          <Label>URL del webhook (callback URL)</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background/60 px-3 py-2 text-xs">
              {webhook.url}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copiar URL"
              onClick={() => copy(webhook.url, "url")}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {copied === "url" && (
              <span className="text-xs text-primary">Copiada ✓</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            La URL contiene el token secreto en la ruta: trátala como una
            contraseña.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Verify token</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background/60 px-3 py-2 text-xs">
              {webhook.verifyToken}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copiar verify token"
              onClick={() => copy(webhook.verifyToken, "vt")}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {copied === "vt" && (
              <span className="text-xs text-primary">Copiado ✓</span>
            )}
          </div>
        </div>
        {webhook.signatureLayer ? (
          <p className="flex items-center gap-2 text-xs text-success">
            <ShieldCheck className="h-4 w-4" /> Verificación de firma activa
            (META_APP_SECRET configurado): cada evento se valida con
            x-hub-signature-256.
          </p>
        ) : (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" /> Sin App Secret
            configurado: el webhook queda protegido por la URL secreta (normal
            en modo agencia). Para la capa extra de firma, agrega
            META_APP_SECRET a la instancia.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
