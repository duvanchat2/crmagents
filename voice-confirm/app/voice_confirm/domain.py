"""Lógica pura de la confirmación: sin red, sin LiveKit. Todo lo de aquí se prueba en tests/."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Literal
from zoneinfo import ZoneInfo

BOGOTA = ZoneInfo("America/Bogota")

CallStatus = Literal[
    "confirmada",  # cédula coincide, confirmó condiciones y dijo "acepto"
    "revision",  # dijo que no, o la cédula no coincide: la oficina decide
    "incompleta",  # contestó pero la llamada terminó antes de completar el guion
    "no_contesta",
    "ocupado",
    "buzon",  # contestó un buzón de voz o un menú automático
    "fallida",  # error técnico al marcar
]

MESES = (
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
)


class InvalidPhone(ValueError):
    pass


def digits_only(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def normalize_co_phone(raw: str) -> str:
    """Devuelve el número en E.164 (+57...). Acepta celulares (3xx) y fijos (60x) de 10 dígitos."""
    digits = digits_only(raw)
    if len(digits) == 12 and digits.startswith("57"):
        digits = digits[2:]
    if len(digits) == 10 and (digits.startswith("3") or digits.startswith("60")):
        return "+57" + digits
    raise InvalidPhone(f"Número colombiano inválido: se esperaban 10 dígitos (3xx o 60x), llegó {len(digits)}")


def parse_holidays(raw: str | None) -> set[date]:
    """Lista separada por comas en formato AAAA-MM-DD (variable COLOMBIA_HOLIDAYS)."""
    holidays: set[date] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if part:
            holidays.add(date.fromisoformat(part))
    return holidays


def is_contact_allowed(now: datetime, holidays: set[date]) -> bool:
    """Horario de la Ley 2300 de 2023: L-V 7:00-19:00, sábado 8:00-15:00, nunca domingo ni festivo."""
    local = now.astimezone(BOGOTA)
    if local.date() in holidays:
        return False
    weekday = local.weekday()
    t = local.time()
    if weekday <= 4:
        return time(7, 0) <= t < time(19, 0)
    if weekday == 5:
        return time(8, 0) <= t < time(15, 0)
    return False


_UNIDADES = (
    "cero",
    "uno",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
    "veinte",
    "veintiuno",
    "veintidós",
    "veintitrés",
    "veinticuatro",
    "veinticinco",
    "veintiséis",
    "veintisiete",
    "veintiocho",
    "veintinueve",
)
_DECENAS = ("", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa")
_CENTENAS = (
    "",
    "ciento",
    "doscientos",
    "trescientos",
    "cuatrocientos",
    "quinientos",
    "seiscientos",
    "setecientos",
    "ochocientos",
    "novecientos",
)


def _menor_que_mil(n: int) -> str:
    if n < 30:
        return _UNIDADES[n]
    if n < 100:
        decena, unidad = divmod(n, 10)
        return _DECENAS[decena] if unidad == 0 else f"{_DECENAS[decena]} y {_UNIDADES[unidad]}"
    if n == 100:
        return "cien"
    centena, resto = divmod(n, 100)
    return _CENTENAS[centena] if resto == 0 else f"{_CENTENAS[centena]} {_menor_que_mil(resto)}"


def _apocopar(texto: str) -> str:
    """'uno' delante de 'mil'/'millones' se dice 'un' ('veintiún mil', 'un millón')."""
    if texto.endswith("veintiuno"):
        return texto[: -len("veintiuno")] + "veintiún"
    if texto.endswith("uno"):
        return texto[:-1]
    return texto


def numero_a_letras(n: int) -> str:
    """Entero no negativo a palabras en español (hasta 999.999.999.999), para que la voz lea bien los pesos."""
    if n < 0:
        raise ValueError("solo enteros no negativos")
    if n < 1000:
        return _menor_que_mil(n)
    if n < 1_000_000:
        miles, resto = divmod(n, 1000)
        cabeza = "mil" if miles == 1 else f"{_apocopar(_menor_que_mil(miles))} mil"
        return cabeza if resto == 0 else f"{cabeza} {_menor_que_mil(resto)}"
    if n < 1_000_000_000_000:
        millones, resto = divmod(n, 1_000_000)
        cabeza = "un millón" if millones == 1 else f"{_apocopar(numero_a_letras(millones))} millones"
        return cabeza if resto == 0 else f"{cabeza} {numero_a_letras(resto)}"
    raise ValueError("número demasiado grande")


def pesos_a_letras(valor: int) -> str:
    texto = numero_a_letras(valor)
    # "un millón de pesos", "dos millones de pesos" (sin resto) llevan "de".
    if valor >= 1_000_000 and valor % 1_000_000 == 0:
        return f"{texto} de pesos"
    return f"{_apocopar(texto)} pesos"


def cuotas_a_letras(n: int) -> str:
    """'una cuota', 'seis cuotas', 'veintiuna cuotas' (cuota es femenino)."""
    if n == 1:
        return "una cuota"
    texto = numero_a_letras(n)
    if texto.endswith("uno"):
        texto = texto[:-1] + "a"
    return f"{texto} cuotas"


def fecha_a_letras(d: date) -> str:
    dia = "primero" if d.day == 1 else numero_a_letras(d.day)
    return f"{dia} de {MESES[d.month - 1]} de {numero_a_letras(d.year)}"


@dataclass(frozen=True)
class Sale:
    venta_id: str
    telefono: str  # E.164
    nombre: str
    cedula: str
    programa: str
    valor_total: int
    numero_cuotas: int
    valor_cuota: int
    fecha_primera_cuota: date
    periodicidad: str = "mensuales"
    contenido: str = ""
    asesor: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "venta_id": self.venta_id,
            "telefono": self.telefono,
            "nombre": self.nombre,
            "cedula": self.cedula,
            "programa": self.programa,
            "valor_total": self.valor_total,
            "numero_cuotas": self.numero_cuotas,
            "valor_cuota": self.valor_cuota,
            "fecha_primera_cuota": self.fecha_primera_cuota.isoformat(),
            "periodicidad": self.periodicidad,
            "contenido": self.contenido,
            "asesor": self.asesor,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Sale:
        return cls(
            venta_id=str(data["venta_id"]),
            telefono=normalize_co_phone(str(data["telefono"])),
            nombre=str(data["nombre"]).strip(),
            cedula=digits_only(str(data["cedula"])),
            programa=str(data["programa"]).strip(),
            valor_total=int(str(data["valor_total"])),
            numero_cuotas=int(str(data["numero_cuotas"])),
            valor_cuota=int(str(data["valor_cuota"])),
            fecha_primera_cuota=date.fromisoformat(str(data["fecha_primera_cuota"])),
            periodicidad=str(data.get("periodicidad") or "mensuales"),
            contenido=str(data.get("contenido") or ""),
            asesor=str(data.get("asesor") or ""),
        )


def greeting_text() -> str:
    return (
        "Hola, le habla el sistema automático de confirmación de Genix Academy. "
        "Esta llamada será grabada para dejar constancia de su matrícula. "
        "Por favor, diga su número de cédula."
    )


def conditions_text(sale: Sale) -> str:
    contenido = f", que incluye {sale.contenido}" if sale.contenido else ""
    periodicidad = sale.periodicidad
    if sale.numero_cuotas == 1 and periodicidad.endswith("es"):
        periodicidad = periodicidad[:-2]  # "una cuota mensual"
    return (
        f"Usted, {sale.nombre}, compró el programa {sale.programa}{contenido}, "
        f"por un valor total de {pesos_a_letras(sale.valor_total)}, "
        f"en {cuotas_a_letras(sale.numero_cuotas)} {periodicidad} "
        f"de {pesos_a_letras(sale.valor_cuota)}. "
        f"La primera cuota se paga el {fecha_a_letras(sale.fecha_primera_cuota)}. "
        "¿Confirma estas condiciones? Diga sí o no."
    )


ACCEPTANCE_PROMPT = "Para terminar, diga en voz alta: yo, su nombre completo, acepto la compra."
GOODBYE_OK = "Listo, su matrícula quedó confirmada. En unos minutos le llega la bienvenida por WhatsApp. Que tenga un buen día."
GOODBYE_REVIEW = "Entendido. Un asesor de Genix lo contactará para revisar su matrícula. Que tenga un buen día."


def build_instructions(sale: Sale) -> str:
    """Instrucciones del agente. El guion es fijo: el modelo no improvisa condiciones."""
    return f"""Eres el sistema automático de confirmación de matrículas de Genix Academy.
Estás en una llamada telefónica con {sale.nombre}. Ya le dijiste este saludo:
"{greeting_text()}"

Tu único trabajo es completar estos pasos, en orden:

1. CÉDULA. Cuando el cliente diga su cédula, llama a la herramienta registrar_cedula con solo los dígitos.
   Si no la entendiste, pídele que la repita despacio. Haz lo que te responda la herramienta.
2. CONDICIONES. Lee EXACTAMENTE este texto, palabra por palabra, sin resumir ni cambiar nada:
   "{conditions_text(sale)}"
   Cuando responda, llama a registrar_confirmacion con confirma=true si dijo que sí, o false si dijo que no o puso reparos.
3. ACEPTACIÓN. Di exactamente: "{ACCEPTANCE_PROMPT}"
   Cuando responda, llama a registrar_aceptacion con acepta=true solo si dijo que acepta la compra, y frase con lo que dijo.
4. DESPEDIDA. Si todo fue afirmativo di exactamente: "{GOODBYE_OK}"
   Si dijo que no a algo, di exactamente: "{GOODBYE_REVIEW}"
   Luego llama a terminar_llamada.

Reglas:
- Habla en español de Colombia, trata al cliente de usted, frases cortas.
- Nunca inventes, cambies, negocies ni expliques condiciones, precios o fechas.
- Nunca digas en voz alta la cédula que el sistema tiene registrada.
- Si pregunta algo fuera del guion, quiere hablar con una persona o no quiere seguir:
  di "{GOODBYE_REVIEW}" y llama a terminar_llamada con el motivo.
- Si te das cuenta de que es un buzón de voz o un menú automático, llama a terminar_llamada con motivo "buzon" sin decir nada más.
"""


def evaluate(
    *,
    cedula_coincide: bool | None,
    confirma_condiciones: bool | None,
    dijo_acepto: bool | None,
) -> CallStatus:
    """Resultado de una llamada que sí contestó un humano."""
    answers = (cedula_coincide, confirma_condiciones, dijo_acepto)
    if any(a is False for a in answers):
        return "revision"
    if all(a is True for a in answers):
        return "confirmada"
    return "incompleta"


def status_from_sip_code(code: int | None) -> CallStatus:
    """Traduce el código SIP de un intento fallido de marcado."""
    if code in (486, 600):
        return "ocupado"
    if code in (408, 480, 487, 603):
        return "no_contesta"
    return "fallida"


def safe_room_fragment(venta_id: str) -> str:
    fragment = re.sub(r"[^A-Za-z0-9_-]", "-", venta_id)[:40].strip("-")
    return fragment or "venta"
