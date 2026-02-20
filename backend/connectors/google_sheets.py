"""
Google Sheets connector: read ranges from the financial model/plan sheet.
Uses a service account; the sheet must be shared with the service account email.
"""
import os
from pathlib import Path
from typing import Any

# Optional: only needed when Google Sheets is configured
try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    _sheets_available = True
except ImportError:
    _sheets_available = False


class GoogleSheetsConnector:
    """Read data from a Google Sheet (e.g. financial model/plan)."""

    def __init__(
        self,
        sheet_id: str | None = None,
        credentials_path: str | None = None,
        credentials_json: str | None = None,
    ):
        """
        sheet_id: The spreadsheet ID from the sheet URL (the long string between /d/ and /edit).
        credentials_path: Path to a JSON key file for the service account.
        credentials_json: Alternatively, the JSON key content as a string (e.g. from env).
        """
        self.sheet_id = sheet_id or os.getenv("GOOGLE_SHEET_ID")
        raw_path = credentials_path if credentials_path is not None else os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        # Resolve relative paths against backend root when provided via base_path (e.g. from main.py)
        self._credentials_path = raw_path
        self._base_path = None  # optional Path for resolving relative credential paths
        self._credentials_json = credentials_json or os.getenv("GOOGLE_SHEETS_CREDENTIALS_JSON")
        self._service = None
        self._drive_service = None

    def set_base_path(self, base_path: Path | str) -> None:
        """Set base path for resolving relative credentials path (call before _get_service)."""
        self._base_path = Path(base_path) if base_path else None

    def _get_service(self):
        """Build the Sheets API service using service account credentials."""
        if not _sheets_available:
            raise RuntimeError(
                "Google Sheets API libraries not installed. "
                "Run: pip install google-auth google-api-python-client"
            )
        if self._service is not None:
            return self._service
        credentials = None
        # spreadsheets = read/write; drive.file = create files owned by the app (often fewer org restrictions than full drive)
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.file",
        ]
        cred_path = self._credentials_path
        if cred_path and self._base_path and not os.path.isabs(cred_path):
            cred_path = str(self._base_path / cred_path)
        if cred_path and os.path.isfile(cred_path):
            credentials = service_account.Credentials.from_service_account_file(
                cred_path,
                scopes=scopes,
            )
        elif self._credentials_json:
            import json
            info = json.loads(self._credentials_json)
            credentials = service_account.Credentials.from_service_account_info(
                info,
                scopes=scopes,
            )
        if not credentials:
            raise ValueError(
                "Google Sheets credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS "
                "(path to JSON key file) or GOOGLE_SHEETS_CREDENTIALS_JSON (JSON string)."
            )
        self._credentials = credentials
        self._service = build("sheets", "v4", credentials=credentials)
        return self._service

    def _get_base_credentials(self):
        """Get base service account credentials (no delegation). Used for delegation."""
        if getattr(self, "_credentials", None) is not None:
            return self._credentials
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.file",
        ]
        cred_path = self._credentials_path
        if cred_path and self._base_path and not os.path.isabs(cred_path):
            cred_path = str(self._base_path / cred_path)
        if cred_path and os.path.isfile(cred_path):
            creds = service_account.Credentials.from_service_account_file(cred_path, scopes=scopes)
        elif self._credentials_json:
            import json
            info = json.loads(self._credentials_json)
            creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        else:
            raise ValueError("Google Sheets credentials not found.")
        self._credentials = creds
        return creds

    def _get_credentials_delegated(self, user_email: str):
        """Return credentials delegated to the given user (domain-wide delegation). File is created in their Drive, their quota."""
        base = self._get_base_credentials()
        return base.with_subject(user_email.strip())

    def _get_drive_service(self):
        """Build the Drive API service (same credentials as Sheets). Used to create new spreadsheets."""
        if not _sheets_available:
            raise RuntimeError("Google API libraries not installed.")
        if self._drive_service is not None:
            return self._drive_service
        # Ensure credentials exist (e.g. via _get_service)
        if getattr(self, "_credentials", None) is None:
            self._get_service()
        self._drive_service = build("drive", "v3", credentials=self._credentials)
        return self._drive_service

    def read_range(self, range_a1: str) -> list[list[Any]]:
        """
        Read a range from the sheet using A1 notation (e.g. "Plan!A1:Z100").
        Returns a list of rows; each row is a list of cell values.
        """
        if not self.sheet_id:
            raise ValueError("GOOGLE_SHEET_ID is not set (required for read)")
        service = self._get_service()
        sheet = service.spreadsheets()
        result = sheet.values().get(
            spreadsheetId=self.sheet_id,
            range=range_a1,
        ).execute()
        return result.get("values", [])

    def update_range(
        self,
        range_a1: str,
        values: list[list[Any]],
        spreadsheet_id: str | None = None,
        credentials_override: Any = None,
    ) -> None:
        """
        Write values to a range using A1 notation.
        spreadsheet_id: if given, write to this spreadsheet; otherwise use self.sheet_id.
        credentials_override: if given (e.g. delegated creds), use these for the Sheets API call.
        """
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            raise ValueError("spreadsheet_id or GOOGLE_SHEET_ID is required for update")
        if credentials_override is not None:
            service = build("sheets", "v4", credentials=credentials_override)
        else:
            service = self._get_service()
        body = {"values": values}
        service.spreadsheets().values().update(
            spreadsheetId=sid,
            range=range_a1,
            valueInputOption="USER_ENTERED",
            body=body,
        ).execute()

    def create_spreadsheet(self, title: str) -> dict:
        """
        Create a new Google Sheet via the Drive API (owned by service account). Returns id and url.
        """
        drive = self._get_drive_service()
        body = {
            "name": title,
            "mimeType": "application/vnd.google-apps.spreadsheet",
        }
        result = drive.files().create(body=body, fields="id,webViewLink").execute()
        sid = result["id"]
        url = result.get("webViewLink") or f"https://docs.google.com/spreadsheets/d/{sid}/edit"
        return {"spreadsheet_id": sid, "spreadsheet_url": url}

    def create_spreadsheet_in_user_drive(self, title: str, user_email: str) -> dict:
        """
        Create a new Google Sheet in the given user's Drive (domain-wide delegation).
        The file is owned by the user, uses their quota, and appears in their Drive.
        Requires: Workspace admin to enable domain-wide delegation for this service account.
        Returns {"spreadsheet_id": id, "spreadsheet_url": url}.
        """
        creds = self._get_credentials_delegated(user_email)
        drive = build("drive", "v3", credentials=creds)
        body = {
            "name": title,
            "mimeType": "application/vnd.google-apps.spreadsheet",
        }
        result = drive.files().create(body=body, fields="id,webViewLink").execute()
        sid = result["id"]
        url = result.get("webViewLink") or f"https://docs.google.com/spreadsheets/d/{sid}/edit"
        return {"spreadsheet_id": sid, "spreadsheet_url": url, "_delegated_creds": creds}

    def is_configured(self) -> bool:
        """True if at least one credential source is set (sheet_id required only for read, not for create)."""
        cred_path = self._credentials_path
        if cred_path and self._base_path and not os.path.isabs(cred_path):
            cred_path = str(self._base_path / cred_path)
        if cred_path and os.path.isfile(cred_path):
            return True
        if self._credentials_json:
            return True
        return False

    def get_service_account_email(self) -> str | None:
        """Return the service account email (client_email) from credentials, for 403 troubleshooting."""
        import json
        if self._credentials_json:
            try:
                info = json.loads(self._credentials_json)
                return info.get("client_email")
            except Exception:
                return None
        cred_path = self._credentials_path
        if cred_path and self._base_path and not os.path.isabs(cred_path):
            cred_path = str(self._base_path / cred_path)
        if cred_path and os.path.isfile(cred_path):
            try:
                with open(cred_path) as f:
                    info = json.load(f)
                return info.get("client_email")
            except Exception:
                return None
        return None
