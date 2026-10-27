import pytest
from pydantic import ValidationError

from voice_confirm.dispatcher import SaleIn

VALID = {
    "venta_id": "GX-000123",
    "telefono": "300 123 4567",
    "nombre": "Carlos Pérez",
    "cedula": "1.234.567.890",
    "programa": "Inteligencia Artificial para Empresas",
    "valor_total": 480000,
    "numero_cuotas": 6,
    "valor_cuota": 80000,
    "fecha_primera_cuota": "2026-11-05",
}


def test_sale_in_normalizes() -> None:
    sale = SaleIn(**VALID).to_sale()
    assert sale.telefono == "+573001234567"
    assert sale.cedula == "1234567890"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("telefono", "12345"),
        ("cedula", "12"),
        ("valor_total", 0),
        ("numero_cuotas", 0),
        ("fecha_primera_cuota", "05/11/2026"),
    ],
)
def test_sale_in_rejects(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        SaleIn(**{**VALID, field: value})
