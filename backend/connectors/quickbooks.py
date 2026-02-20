"""
QuickBooks Online connector: fetch P&L, Balance Sheet, and Cash Flow reports.
Uses OAuth 2.0 refresh token. Configure via .env (client_id, client_secret, realm_id, refresh_token).
"""
import base64
import os
from typing import Any

try:
    import requests
    _requests_available = True
except ImportError:
    _requests_available = False

QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
QB_API_BASE_PROD = "https://quickbooks.api.intuit.com/v3/company"
QB_API_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com/v3/company"


class QuickBooksConnector:
    """Fetch financial reports from QuickBooks Online."""

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        realm_id: str | None = None,
        refresh_token: str | None = None,
        sandbox: bool | None = None,
    ):
        self.client_id = client_id or os.getenv("QB_CLIENT_ID")
        self.client_secret = client_secret or os.getenv("QB_CLIENT_SECRET")
        self.realm_id = realm_id or os.getenv("QB_REALM_ID")
        self.refresh_token = refresh_token or os.getenv("QB_REFRESH_TOKEN")
        _sandbox = sandbox if sandbox is not None else os.getenv("QB_SANDBOX", "").lower() in ("1", "true", "yes")
        self.api_base = QB_API_BASE_SANDBOX if _sandbox else QB_API_BASE_PROD
        self._access_token: str | None = None

    def _get_access_token(self) -> str:
        if not _requests_available:
            raise RuntimeError("requests is not installed. Run: pip install requests")
        if not all([self.client_id, self.client_secret, self.refresh_token]):
            raise ValueError(
                "QB_CLIENT_ID, QB_CLIENT_SECRET, and QB_REFRESH_TOKEN must be set in .env"
            )
        auth = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        r = requests.post(
            QB_TOKEN_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {auth}",
            },
            data={"grant_type": "refresh_token", "refresh_token": self.refresh_token},
            timeout=30,
        )
        if not r.ok:
            try:
                err_body = r.json()
                err_msg = err_body.get("error_description") or err_body.get("error") or r.text
            except Exception:
                err_msg = r.text
            raise RuntimeError(f"QuickBooks token refresh failed ({r.status_code}): {err_msg}")
        data = r.json()
        self._access_token = data["access_token"]
        if "refresh_token" in data:
            self.refresh_token = data["refresh_token"]
        return self._access_token

    def _ensure_token(self) -> str:
        if self._access_token:
            return self._access_token
        return self._get_access_token()

    def get_report(
        self,
        report_name: str,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        """
        Fetch a report. report_name: ProfitAndLoss, BalanceSheet, or CashFlow.
        start_date / end_date: YYYY-MM-DD (optional; QB may use default period).
        """
        if not _requests_available:
            raise RuntimeError("requests is not installed. Run: pip install requests")
        if not self.realm_id:
            raise ValueError("QB_REALM_ID must be set in .env")
        token = self._ensure_token()
        url = f"{self.api_base}/{self.realm_id}/reports/{report_name}"
        params = {}
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        r = requests.get(
            url,
            headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
            params=params or None,
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def get_profit_and_loss(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> dict[str, Any]:
        return self.get_report("ProfitAndLoss", start_date, end_date)

    def get_balance_sheet(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> dict[str, Any]:
        return self.get_report("BalanceSheet", start_date, end_date)

    def get_cash_flow(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> dict[str, Any]:
        return self.get_report("CashFlow", start_date, end_date)

    def is_configured(self) -> bool:
        return bool(
            (self.client_id or os.getenv("QB_CLIENT_ID"))
            and (self.client_secret or os.getenv("QB_CLIENT_SECRET"))
            and (self.realm_id or os.getenv("QB_REALM_ID"))
            and (self.refresh_token or os.getenv("QB_REFRESH_TOKEN"))
        )
