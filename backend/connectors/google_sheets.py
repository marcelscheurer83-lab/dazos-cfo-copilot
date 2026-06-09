"""
Google Sheets connector: read ranges from the financial model/plan sheet.
Uses a service account; the sheet must be shared with the service account email.
"""
import os
import re
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
        # spreadsheets = read/write; drive.file = create files owned by the app (often fewer org restrictions than full drive);
        # presentations = read/write Google Slides decks shared with the service account.
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/presentations",
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
            "https://www.googleapis.com/auth/presentations",
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

    @staticmethod
    def _align_values_to_requested_top_row(values: list[list[Any]], api_range: str | None) -> list[list[Any]]:
        """
        The Sheets API may omit leading **empty** rows from ``values``. Row 1 of the sheet must be ``values[0]``
        for callers that index by Excel row (e.g. BU35 = row 35 → index 34). If the response ``range`` starts
        at row N>1, prepend N-1 empty rows.
        """
        if not values or not api_range:
            return values
        # Examples: 'ARR_Calculations_2026P'!A1:ZZ1000  or  Sheet!A35:ZZ1000
        m = re.search(r"!([A-Z]+)(\d+)(?::|$)", api_range.replace("'", ""))
        if not m:
            return values
        start_row = int(m.group(2))
        if start_row <= 1:
            return values
        pad = [[] for _ in range(start_row - 1)]
        return pad + values

    def _fetch_values(
        self, range_a1: str, spreadsheet_id: str | None = None
    ) -> tuple[list[list[Any]], str | None]:
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            raise ValueError("spreadsheet_id or GOOGLE_SHEET_ID is required for read")
        service = self._get_service()
        sheet = service.spreadsheets()
        result = sheet.values().get(
            spreadsheetId=sid,
            range=range_a1,
            valueRenderOption="UNFORMATTED_VALUE",
        ).execute()
        return result.get("values", []), result.get("range")

    def read_range_values_raw(self, range_a1: str, spreadsheet_id: str | None = None) -> list[list[Any]]:
        """
        Values exactly as returned by the API (no row padding). Use when merging a single cell
        (e.g. ``BU35:BU35``) into a larger grid: padded reads would leave column BU at the wrong index.
        """
        values, _ = self._fetch_values(range_a1, spreadsheet_id)
        return values

    def read_range(self, range_a1: str, spreadsheet_id: str | None = None) -> list[list[Any]]:
        """
        Read a range from the sheet using A1 notation (e.g. "Plan!A1:Z100").
        spreadsheet_id: if given, read from this spreadsheet; otherwise use self.sheet_id.
        Returns a list of rows; each row is a list of cell values.
        """
        values, api_range = self._fetch_values(range_a1, spreadsheet_id)
        return self._align_values_to_requested_top_row(values, api_range)

    def list_sheets(self, spreadsheet_id: str | None = None) -> list[dict]:
        """Return a list of all tabs: [{title, sheetId, rowCount, columnCount}]."""
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            raise ValueError("spreadsheet_id or GOOGLE_SHEET_ID is required")
        service = self._get_service()
        meta = service.spreadsheets().get(
            spreadsheetId=sid,
            fields="sheets(properties(sheetId,title,gridProperties))",
        ).execute()
        result = []
        for sh in meta.get("sheets") or []:
            props = sh.get("properties") or {}
            grid = props.get("gridProperties") or {}
            result.append({
                "title": props.get("title", ""),
                "sheetId": props.get("sheetId"),
                "rowCount": grid.get("rowCount", 0),
                "columnCount": grid.get("columnCount", 0),
            })
        return result

    def get_sheet_gid_by_title(
        self,
        sheet_title: str,
        spreadsheet_id: str | None = None,
    ) -> int | None:
        """
        Return the sheet (tab) gid for the given title, or None if not found.
        Use for building a direct link: .../edit#gid={sheetId}
        """
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            return None
        service = self._get_service()
        meta = service.spreadsheets().get(
            spreadsheetId=sid,
            fields="sheets(properties(sheetId,title))",
        ).execute()
        for sh in meta.get("sheets") or []:
            props = sh.get("properties") or {}
            if (props.get("title") or "").strip().lower() == sheet_title.strip().lower():
                return props.get("sheetId")
        return None

    def get_sheet_exact_title(
        self,
        sheet_title: str,
        spreadsheet_id: str | None = None,
    ) -> str | None:
        """
        Return the exact title of the sheet as stored in the API (match by case-insensitive name).
        Use this when building A1 ranges so the name matches exactly.
        """
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            return None
        service = self._get_service()
        meta = service.spreadsheets().get(
            spreadsheetId=sid,
            fields="sheets(properties(title))",
        ).execute()
        for sh in meta.get("sheets") or []:
            props = sh.get("properties") or {}
            title = (props.get("title") or "").strip()
            if title.lower() == sheet_title.strip().lower():
                return title
        return None

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

    def ensure_sheet_exists(
        self,
        sheet_title: str,
        spreadsheet_id: str | None = None,
        credentials_override: Any = None,
    ) -> None:
        """
        If the spreadsheet does not have a sheet with the given title, add one.
        spreadsheet_id: if given, use this spreadsheet; otherwise use self.sheet_id.
        """
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            raise ValueError("spreadsheet_id or GOOGLE_SHEET_ID is required")
        if credentials_override is not None:
            service = build("sheets", "v4", credentials=credentials_override)
        else:
            service = self._get_service()
        meta = service.spreadsheets().get(
            spreadsheetId=sid,
            fields="sheets(properties(sheetId,title))",
        ).execute()
        sheets = meta.get("sheets") or []
        for sh in sheets:
            props = sh.get("properties") or {}
            if (props.get("title") or "").strip().lower() == sheet_title.strip().lower():
                return  # already exists
        # Add new sheet with this title
        service.spreadsheets().batchUpdate(
            spreadsheetId=sid,
            body={"requests": [{"addSheet": {"properties": {"title": sheet_title.strip()}}}]},
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

    # ── Google Slides ─────────────────────────────────────────────────────────
    def _get_slides_service(self):
        """Build the Slides API service (same service-account credentials as Sheets)."""
        if not _sheets_available:
            raise RuntimeError("Google API libraries not installed.")
        if getattr(self, "_slides_service", None) is not None:
            return self._slides_service
        if getattr(self, "_credentials", None) is None:
            self._get_service()  # populates self._credentials with all scopes
        self._slides_service = build("slides", "v1", credentials=self._credentials)
        return self._slides_service

    def get_presentation(self, presentation_id: str) -> dict:
        """Return the presentation resource (slides, pageSize, etc.)."""
        service = self._get_slides_service()
        return service.presentations().get(presentationId=presentation_id).execute()

    def slides_batch_update(self, presentation_id: str, requests: list[dict]) -> dict:
        """Execute a list of raw Slides API batchUpdate requests."""
        service = self._get_slides_service()
        return service.presentations().batchUpdate(
            presentationId=presentation_id,
            body={"requests": requests},
        ).execute()

    def get_slide_thumbnail_url(self, presentation_id: str, page_object_id: str) -> str | None:
        """Return a temporary contentUrl image of the given slide page (PNG)."""
        service = self._get_slides_service()
        try:
            resp = service.presentations().pages().getThumbnail(
                presentationId=presentation_id,
                pageObjectId=page_object_id,
                thumbnailProperties_mimeType="PNG",
                thumbnailProperties_thumbnailSize="LARGE",
            ).execute()
            return resp.get("contentUrl")
        except TypeError:
            # Older client signature: pass nested dict is not supported; fall back without size.
            resp = service.presentations().pages().getThumbnail(
                presentationId=presentation_id,
                pageObjectId=page_object_id,
            ).execute()
            return resp.get("contentUrl")

    def batch_update(self, requests: list[dict], spreadsheet_id: str | None = None) -> dict:
        """
        Execute a list of raw Sheets API batchUpdate requests (e.g. formatting, freeze rows).
        Returns the API response dict.
        """
        sid = spreadsheet_id or self.sheet_id
        if not sid:
            raise ValueError("spreadsheet_id or GOOGLE_SHEET_ID is required for batch_update")
        service = self._get_service()
        result = service.spreadsheets().batchUpdate(
            spreadsheetId=sid,
            body={"requests": requests},
        ).execute()
        return result

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
