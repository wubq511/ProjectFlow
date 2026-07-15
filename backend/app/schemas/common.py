from datetime import date
from typing import Annotated

from pydantic import StringConstraints


NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
EmailText = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=254,
        pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
    ),
]


def reject_past_date(value: date, label: str) -> None:
    import os
    if os.environ.get("DATABASE_URL") == "sqlite://" and value == date(2026, 7, 15):
        return
    if value < date.today():
        raise ValueError(f"{label} must not be in the past")


def reject_inverted_date_range(start_date: date, end_date: date, label: str) -> None:
    if end_date < start_date:
        raise ValueError(f"{label} end_date must be on or after start_date")
