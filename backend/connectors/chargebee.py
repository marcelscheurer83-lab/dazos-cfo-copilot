"""
Chargebee connector: fetch subscriptions and invoices for billing reconciliation.
ARR remains sourced from Salesforce; Chargebee is the billing engine.
Uses API key auth. Configure via .env: CHARGEBEE_SITE, CHARGEBEE_API_KEY.
"""
import base64
import os
from typing import Any

try:
    import requests
    _requests_available = True
except ImportError:
    _requests_available = False

CHARGEBEE_API_BASE = "https://{site}.chargebee.com/api/v2"


class ChargebeeConnector:
    """Fetch subscriptions and invoices from Chargebee (billing engine)."""

    def __init__(
        self,
        site: str | None = None,
        api_key: str | None = None,
    ):
        self.site = (site or os.getenv("CHARGEBEE_SITE") or "").strip().rstrip("/")
        self.api_key = (api_key or os.getenv("CHARGEBEE_API_KEY") or "").strip()
        self._base_url = CHARGEBEE_API_BASE.format(site=self.site) if self.site else ""

    def _headers(self) -> dict[str, str]:
        """Basic Auth: API key as username, empty password (per Chargebee docs)."""
        if not self.api_key:
            return {}
        raw = f"{self.api_key}:"
        encoded = base64.b64encode(raw.encode()).decode()
        return {"Authorization": f"Basic {encoded}"}

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not _requests_available:
            raise RuntimeError("requests is not installed. Run: pip install requests")
        if not self.site or not self.api_key:
            raise ValueError("CHARGEBEE_SITE and CHARGEBEE_API_KEY must be set in .env")
        url = f"{self._base_url}{path}"
        r = requests.get(
            url,
            headers=self._headers(),
            params=params or {},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def list_subscriptions(
        self,
        limit: int = 100,
        offset: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        """
        List subscriptions. Returns API response with "list" and optional "next_offset".
        status: optional filter e.g. "active", "cancelled", "non_renewing".
        """
        params = {"limit": min(100, max(1, limit))}
        if offset:
            params["offset"] = offset
        if status:
            params["status[is]"] = status
        return self._get("/subscriptions", params)

    def list_invoices(
        self,
        limit: int = 100,
        offset: str | None = None,
        status: str | None = None,
        date_after_ts: int | None = None,
        date_before_ts: int | None = None,
    ) -> dict[str, Any]:
        """
        List invoices. Returns API response with "list" and optional "next_offset".
        status: optional filter e.g. "paid", "payment_due", "not_paid".
        date_after_ts / date_before_ts: optional unix timestamp filters on invoice date.
        """
        params = {"limit": min(100, max(1, limit))}
        if offset:
            params["offset"] = offset
        if status:
            params["status[is]"] = status
        if date_after_ts is not None:
            params["date[after]"] = date_after_ts
        if date_before_ts is not None:
            params["date[before]"] = date_before_ts
        return self._get("/invoices", params)

    def fetch_invoices_in_date_range(
        self,
        date_from_ts: int,
        date_to_ts: int,
        max_pages: int = 30,
    ) -> list[dict[str, Any]]:
        """
        Fetch invoices with date in [date_from_ts, date_to_ts]. Sorts newest-first so we
        get recent invoices without paginating through years. Stops when invoice date < date_from_ts.
        Returns list of invoice dicts.
        """
        out: list[dict[str, Any]] = []
        offset: str | None = None
        for _ in range(max_pages):
            params: dict[str, Any] = {"limit": 100, "sort_by[desc]": "date"}
            if offset:
                params["offset"] = offset
            try:
                resp = self._get("/invoices", params)
            except Exception:
                break
            items = resp.get("list") or []
            for item in items:
                inv = item.get("invoice") if isinstance(item, dict) else getattr(item, "invoice", item)
                if not inv:
                    continue
                inv_dict = inv if isinstance(inv, dict) else dict(inv)
                inv_date = inv_dict.get("date")
                if inv_date is None:
                    continue
                try:
                    ts = int(inv_date)
                except (TypeError, ValueError):
                    continue
                if ts < date_from_ts:
                    return out
                if ts <= date_to_ts:
                    out.append(inv_dict)
            offset = resp.get("next_offset")
            if not offset or len(items) < 100:
                break
        return out

    def fetch_paid_invoices_for_collections(
        self,
        date_from_ts: int,
        date_to_ts: int,
        max_pages: int = 50,
    ) -> list[dict[str, Any]]:
        """
        Fetch paid invoices that may have paid_at in [date_from_ts, date_to_ts].
        Uses a wide invoice-date window (date_from - 1 year to date_to) so we include
        invoices issued earlier but paid in the window. Returns list of invoice dicts
        (status=paid); filter by paid_at in caller. amount_paid in cents, paid_at in seconds.
        """
        window_start = date_from_ts - (365 * 86400)
        out: list[dict[str, Any]] = []
        offset: str | None = None
        for _ in range(max_pages):
            params: dict[str, Any] = {
                "limit": 100,
                "status[is]": "paid",
                "date[after]": window_start,
                "date[before]": date_to_ts,
                "sort_by[desc]": "date",
            }
            if offset:
                params["offset"] = offset
            try:
                resp = self._get("/invoices", params)
            except Exception:
                break
            items = resp.get("list") or []
            for item in items:
                inv = item.get("invoice") if isinstance(item, dict) else getattr(item, "invoice", item)
                if not inv:
                    continue
                inv_dict = inv if isinstance(inv, dict) else dict(inv)
                inv_date = inv_dict.get("date")
                try:
                    ts = int(inv_date) if inv_date is not None else None
                except (TypeError, ValueError):
                    ts = None
                if ts is not None and ts < window_start:
                    return out
                out.append(inv_dict)
            offset = resp.get("next_offset")
            if not offset or len(items) < 100:
                break
        return out

    def list_customers(self, limit: int = 100, offset: str | None = None) -> dict[str, Any]:
        """List customers. Returns API response with "list" and optional "next_offset"."""
        params = {"limit": min(100, max(1, limit))}
        if offset:
            params["offset"] = offset
        return self._get("/customers", params)

    def get_customer(self, customer_id: str) -> dict[str, Any]:
        """Retrieve a single customer by Chargebee customer ID. Returns the customer dict."""
        resp = self._get(f"/customers/{customer_id}", {})
        return resp.get("customer", resp)

    def fetch_all_customers(self) -> list[dict[str, Any]]:
        """Fetch all customers with pagination. Returns list of customer dicts."""
        out: list[dict[str, Any]] = []
        offset: str | None = None
        while True:
            resp = self.list_customers(limit=100, offset=offset)
            items = resp.get("list") or []
            for item in items:
                out.append(item.get("customer", item))
            offset = resp.get("next_offset")
            if not offset or len(items) < 100:
                break
        return out

    def list_transactions(
        self,
        limit: int = 100,
        offset: str | None = None,
        type: str | None = None,
        status: str | None = None,
        date_after_ts: int | None = None,
        date_before_ts: int | None = None,
    ) -> dict[str, Any]:
        """
        List transactions. Returns API response with "list" and optional "next_offset".
        type: optional e.g. "payment", "refund".
        status: optional e.g. "success", "failure".
        date_after_ts / date_before_ts: optional unix timestamp filters on transaction date.
        """
        params = {"limit": min(100, max(1, limit))}
        if offset:
            params["offset"] = offset
        if type:
            params["type[is]"] = type
        if status:
            params["status[is]"] = status
        if date_after_ts is not None:
            params["date[after]"] = date_after_ts
        if date_before_ts is not None:
            params["date[before]"] = date_before_ts
        return self._get("/transactions", params)

    def fetch_payments_in_date_range(
        self,
        date_from_ts: int,
        date_to_ts: int,
        max_pages: int = 50,
    ) -> list[dict[str, Any]]:
        """
        Fetch successful payment transactions with date in [date_from_ts, date_to_ts].
        Matches Chargebee "Total Payments" export: one row per payment, keyed by payment date.
        Returns list of transaction dicts (type=payment, status=success). amount is in cents.
        """
        out: list[dict[str, Any]] = []
        offset: str | None = None
        for _ in range(max_pages):
            params: dict[str, Any] = {
                "limit": 100,
                "type[is]": "payment",
                "status[is]": "success",
                "date[after]": date_from_ts,
                "date[before]": date_to_ts,
                "sort_by[asc]": "date",
            }
            if offset:
                params["offset"] = offset
            try:
                resp = self._get("/transactions", params)
            except Exception:
                break
            items = resp.get("list") or []
            for item in items:
                txn = item.get("transaction") if isinstance(item, dict) else getattr(item, "transaction", item)
                if not txn:
                    continue
                txn_dict = txn if isinstance(txn, dict) else dict(txn)
                out.append(txn_dict)
            offset = resp.get("next_offset")
            if not offset or len(items) < 100:
                break
        return out

    def is_configured(self) -> bool:
        """True if site and API key are set."""
        return bool(self.site and self.api_key)
