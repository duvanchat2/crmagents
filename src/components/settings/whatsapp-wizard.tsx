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

type NumberItem = {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  label: string;
  provider: Provider;
  status: "connected" | "reconnect_required";
  isDefault: boolean;
  enabled: boolean;
  tokenLast4: string | null;
  problem: string | null;
};

type AvailableNumber = {
  phoneNumberId: string;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  state: "available" | "connected" | "taken";
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
  const [numbers, setNumbers] = useState<NumberItem[]>([]);
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
      setNumbers(c.numbers ?? []);
      setTransport({ provider: c.provider ?? "meta", apiKeyLast4: c.apiKeyLast4 ?? null });
    }
    if (w) setWebhook(w);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function patchNumber(id: string, patch: { isDefault?: true; enabled?: boolean }) {
    const res = await fetch(`/api/settings/whatsapp/numbers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { numbers?: NumberItem[] } | null;
    if (data?.numbers) setNumbers(data.numbers);
    else void refetch();
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const mismatched = numbers.filter((n) => n.enabled && n.provider !== transport.provider);

  return (
    <div className="max-w-3xl space-y-6">
      {mismatched.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-[#ece2cf] bg-[#faf7f0] p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8a6d3b]" />
          <div>
            <p className="font-medium text-[#8a6d3b]">
              La conexión guardada es de {PROVIDER_LABEL[mismatched[0]!.provider]}, pero
              esta instancia usa {PROVIDER_LABEL[transport.provider]}.
            </p>
            <p className="text-[#8a6d3b]/80">
              Los envíos por {mismatched.length === 1 ? "ese número" : "esos números"} están
              pausados hasta que los vuelvas a conectar abajo.
            </p>
          </div>
        </div>
      )}

      {numbers.some((n) => n.status === "reconnect_required" && n.provider === transport.provider) && (
        <div className="flex items-start gap-2 rounded-lg border border-[#ecd4d2] bg-[#faf1f0] p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-[#a2504c]">
              El token de WhatsApp de un número expiró o fue revocado.
            </p>
            <p className="text-[#a2504c]/80">
              Los envíos por ese número están pausados. Pega un token nuevo abajo y
              prueba la conexión para reconectar.
            </p>
          </div>
        </div>
      )}

      {numbers.length > 0 && (
        <NumbersCard numbers={numbers} transport={transport} onPatch={patchNumber} />
      )}

      {transport.provider === "kapso" && (
        <KapsoDiscoveryCard onConnected={() => void refetch()} />
      )}

      <ConnectForm
        hasNumbers={numbers.length > 0}
        transport={transport}
        onSaved={() => void refetch()}
      />

      {webhook && <WebhookCard webhook={webhook} provider={transport.provider} />}
    </div>
  );
}

function NumbersCard({
  numbers,
  transport,
  onPatch,
}: {
  numbers: NumberItem[];
  transport: Transport;
  onPatch: (id: string, patch: { isDefault?: true; enabled?: boolean }) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Números conectados</CardTitle>
        <CardDescription>
          Cada conversación sale por el número por el que llegó. El
          predeterminado se preselecciona al iniciar un chat nuevo. Desactivar
          un número no borra su historial.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border" data-testid="numbers-list">
          {numbers.map((n) => (
            <li
              key={n.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="number-row"
              data-phone-number-id={n.phoneNumberId}
            >
              {n.enabled && !n.problem ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 shrink-0 text-[#8a6d3b]" />
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">
                  Número conectado: {n.displayPhoneNumber ?? n.phoneNumberId}
                </p>
                <p className="text-xs text-muted-foreground">
                  {n.verifiedName ? `${n.verifiedName} · ` : ""}
                  {n.provider === "kapso"
                    ? `vía Kapso · API key …${transport.apiKeyLast4 ?? "????"}`
                    : `token …${n.tokenLast4 ?? "????"}`}
                  {` · WABA ${n.wabaId}`}
                </p>
                {n.problem && n.enabled && (
                  <p className="mt-0.5 text-xs text-[#8a6d3b]">{n.problem}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {n.isDefault && <Badge variant="success">Predeterminado</Badge>}
                {!n.enabled && <Badge>Desactivado</Badge>}
                {n.enabled && !n.isDefault && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onPatch(n.id, { isDefault: true })}
                  >
                    Hacer predeterminado
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onPatch(n.id, { enabled: !n.enabled })}
                >
                  {n.enabled ? "Desactivar" : "Activar"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function KapsoDiscoveryCard({ onConnected }: { onConnected: () => void }) {
  const [items, setItems] = useState<AvailableNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/settings/whatsapp/available").catch(() => null);
    const data = (await res?.json().catch(() => null)) as {
      numbers?: AvailableNumber[];
      error?: { message?: string };
    } | null;
    if (!res?.ok || !data?.numbers) {
      setError(data?.error?.message ?? "No se pudo consultar Kapso");
      setItems([]);
      return;
    }
    setItems(data.numbers);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(n: AvailableNumber) {
    setBusy(n.phoneNumberId);
    setError(null);
    const res = await fetch("/api/settings/whatsapp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumberId: n.phoneNumberId, wabaId: n.wabaId ?? "" }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo conectar el número");
      return;
    }
    await load();
    onConnected();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Números de tu cuenta de Kapso</CardTitle>
        <CardDescription>
          Elige qué números atiende esta organización. Los conectas en
          app.kapso.ai; aquí solo decides cuáles entran a Vocero.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items === null ? (
          <p className="text-sm text-muted-foreground">Consultando Kapso…</p>
        ) : items.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">
            Tu cuenta de Kapso no tiene números conectados.
          </p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="kapso-available">
            {items.map((n) => (
              <li
                key={n.phoneNumberId}
                className="flex items-center gap-3 px-4 py-2.5 text-sm"
                data-phone-number-id={n.phoneNumberId}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{n.displayPhoneNumber ?? n.phoneNumberId}</p>
                  <p className="text-xs text-muted-foreground">
                    {n.verifiedName ?? "Sin nombre verificado"} · {n.phoneNumberId}
                  </p>
                </div>
                {n.state === "connected" ? (
                  <Badge variant="success">En esta organización</Badge>
                ) : n.state === "taken" ? (
                  <Badge>En otra organización</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void connect(n)}
                  >
                    {busy === n.phoneNumberId ? "Conectando…" : "Conectar"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function ConnectForm({
  hasNumbers,
  transport,
  onSaved,
}: {
  hasNumbers: boolean;
  transport: Transport;
  onSaved: () => void;
}) {
  const isKapso = transport.provider === "kapso";
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
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
    setPhoneNumberId("");
    setWabaId("");
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {hasNumbers ? "Agregar o reconectar un número" : "Conectar tu número de WhatsApp"}
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
              onChange={(e) => {
                setPhoneNumberId(e.target.value);
                setTestResult(null); // el resultado era de otro número
              }}
            />
          </div>
        </div>
        {!isKapso && (
        <div className="space-y-1.5">
          <Label htmlFor="token">Token de acceso</Label>
          <Input
            id="token"
            type="password"
            placeholder="EAAG…"
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
