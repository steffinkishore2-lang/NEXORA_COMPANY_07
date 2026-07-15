"""Local production-style contact endpoint for the Synapse landing page.

Run: pip install -r requirements.txt && uvicorn server:app --host 127.0.0.1 --port 8000
Open: http://127.0.0.1:8000

Optional email delivery uses standard SMTP. Set SMTP_HOST, SMTP_PORT, SMTP_USER,
SMTP_PASSWORD and SMTP_FROM before starting the server.
"""
from __future__ import annotations

import html
import os
import re
import smtplib
import sqlite3
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

ROOT = Path(__file__).parent
DB_PATH = ROOT / "contact_submissions.sqlite3"
EMAIL_TO = "mariavictor592@gmail.com"
PHONE_RE = re.compile(r"^[0-9+()\-\s]{7,30}$")
RATE_LIMIT: dict[str, list[float]] = {}

app = FastAPI(title="Synapse Contact API")
app.add_middleware(
    CORSMiddleware,
    # Supports both the served site and a local file preview without CORS failures.
    allow_origins=["null", "http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)
app.mount("/assets", StaticFiles(directory=ROOT), name="assets")


class ContactSubmission(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=100)]
    phone: Annotated[str, Field(min_length=7, max_length=30)]
    email: EmailStr
    message: Annotated[str, Field(min_length=10, max_length=5000)]
    company: str = ""  # Honeypot field: legitimate visitors never see it.


def init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT NOT NULL,
                message TEXT NOT NULL,
                submitted_at TEXT NOT NULL,
                ip_address TEXT
            )"""
        )


@app.on_event("startup")
def startup() -> None:
    init_db()


def rate_limit(ip: str) -> None:
    now = time.time()
    attempts = [stamp for stamp in RATE_LIMIT.get(ip, []) if now - stamp < 3600]
    if len(attempts) >= 5:
        raise HTTPException(429, "Please wait before sending another inquiry.")
    attempts.append(now)
    RATE_LIMIT[ip] = attempts


def send_notification(data: ContactSubmission, submitted_at: str) -> None:
    """Sends only when SMTP credentials are supplied; submissions always persist."""
    host = os.getenv("SMTP_HOST")
    username = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    if not all((host, username, password)):
        return
    message = EmailMessage()
    message["Subject"] = f"New Synapse project inquiry — {data.name}"
    message["From"] = os.environ.get("SMTP_FROM", username)
    message["To"] = EMAIL_TO
    message.set_content(
        f"Name: {data.name}\nPhone: {data.phone}\nEmail: {data.email}\n"
        f"Submitted: {submitted_at}\n\nProject requirement:\n{data.message}"
    )
    port = int(os.getenv("SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=12) as server:
        server.starttls()
        server.login(username, password)
        server.send_message(message)


@app.get("/")
def landing_page() -> FileResponse:
    return FileResponse(ROOT / "ai-software-company.html")


@app.post("/api/contact", status_code=201)
def create_contact(submission: ContactSubmission, request: Request) -> dict[str, bool]:
    if submission.company.strip():
        # Do not reveal that the spam trap was triggered.
        return {"ok": True}
    if not PHONE_RE.fullmatch(submission.phone.strip()):
        raise HTTPException(422, "Enter a valid phone number.")
    ip = request.client.host if request.client else "unknown"
    rate_limit(ip)
    submitted_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO submissions (name, phone, email, message, submitted_at, ip_address) VALUES (?, ?, ?, ?, ?, ?)",
            (submission.name.strip(), submission.phone.strip(), str(submission.email), submission.message.strip(), submitted_at, ip),
        )
    try:
        send_notification(submission, submitted_at)
    except (OSError, smtplib.SMTPException):
        # Persistence succeeds even if a temporary mail provider error occurs.
        pass
    return {"ok": True}
