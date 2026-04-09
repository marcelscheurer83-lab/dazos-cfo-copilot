"""
Salesforce connector: query opportunities and other objects for ARR and GTM.
Uses username + password + security token (or OAuth). Configure via .env.
"""
import os
from typing import Any

try:
    from simple_salesforce import Salesforce
    _salesforce_available = True
except ImportError:
    _salesforce_available = False


class SalesforceConnector:
    """Query Salesforce (Opportunities, etc.) for ARR and GTM metrics."""

    def __init__(
        self,
        username: str | None = None,
        password: str | None = None,
        security_token: str | None = None,
        domain: str | None = None,
    ):
        """
        username: Salesforce username (email).
        password: Salesforce password.
        security_token: Security token (append to password if not using separate param).
        domain: 'login' (production) or 'test' (sandbox). Default from env or 'login'.
        """
        self.username = username or os.getenv("SALESFORCE_USERNAME")
        self.password = password or os.getenv("SALESFORCE_PASSWORD")
        self.security_token = security_token or os.getenv("SALESFORCE_SECURITY_TOKEN")
        self.domain = (domain or os.getenv("SALESFORCE_DOMAIN") or "login").lower()
        if self.domain not in ("login", "test"):
            self.domain = "login"
        self._sf = None

    def _get_client(self) -> "Salesforce":
        if not _salesforce_available:
            raise RuntimeError(
                "simple_salesforce is not installed. Run: pip install simple-salesforce"
            )
        if self._sf is not None:
            return self._sf
        if not self.username or not self.password:
            raise ValueError(
                "SALESFORCE_USERNAME and SALESFORCE_PASSWORD must be set in .env"
            )
        # simple_salesforce expects security_token as a separate parameter (not appended to password)
        kwargs = {
            "username": self.username,
            "password": self.password,
            "domain": self.domain,
        }
        if self.security_token:
            kwargs["security_token"] = self.security_token
        self._sf = Salesforce(**kwargs)
        return self._sf

    def query(self, soql: str) -> list[dict[str, Any]]:
        """
        Run a SOQL query and return a list of record dicts (with attributes flattened).
        """
        sf = self._get_client()
        result = sf.query_all(soql)
        records = []
        for rec in result.get("records", []):
            row = {}
            for key, value in rec.items():
                if key == "attributes":
                    continue
                if isinstance(value, dict) and "attributes" in value:
                    # Reference (e.g. Account): use Name or Id
                    row[f"{key}_Id"] = value.get("Id")
                    if "Name" in value:
                        row[f"{key}_Name"] = value["Name"]
                else:
                    row[key] = value
            records.append(row)
        return records

    def run_report(self, report_id: str, include_details: bool = True) -> dict[str, Any]:
        """
        Run a Salesforce Analytics report and return the full result dict.
        Uses the Analytics REST API: /services/data/vXX.0/analytics/reports/{reportId}
        include_details=True fetches row-level detail records (not just summary).
        Returns the raw API response dict.
        """
        sf = self._get_client()
        endpoint = f"analytics/reports/{report_id}"
        params = {"includeDetails": "true"} if include_details else {}
        # simple_salesforce exposes a generic REST helper
        result = sf.restful(endpoint, params=params, method="GET")
        return result

    def get_report_metadata(self, report_id: str) -> dict[str, Any]:
        """Return report metadata (column labels, filters, etc.) without running it."""
        sf = self._get_client()
        result = sf.restful(f"analytics/reports/{report_id}/describe")
        return result

    @staticmethod
    def extract_report_rows(report_result: dict[str, Any]) -> list[dict[str, Any]]:
        """
        Flatten a Salesforce Analytics report result into a list of row dicts.
        Handles tabular and summary report formats.
        Returns [{column_label: value, ...}, ...]
        """
        rows: list[dict[str, Any]] = []
        report_metadata = report_result.get("reportMetadata", {})
        report_format = report_metadata.get("reportFormat", "TABULAR")
        extended_meta = report_result.get("reportExtendedMetadata", {})
        col_info = extended_meta.get("detailColumnInfo", {})

        # Build label map: api_name → human label
        label_map: dict[str, str] = {}
        for api_name, meta in col_info.items():
            label_map[api_name] = meta.get("label", api_name)

        fact_map = report_result.get("factMap", {})

        if report_format == "TABULAR":
            # Tabular: factMap key is "T!T"
            entry = fact_map.get("T!T", {})
            for row in entry.get("rows", []):
                cells = row.get("dataCells", [])
                col_names = report_metadata.get("detailColumns", [])
                row_dict: dict[str, Any] = {}
                for i, col in enumerate(col_names):
                    if i < len(cells):
                        cell = cells[i]
                        row_dict[label_map.get(col, col)] = cell.get("label") or cell.get("value")
                rows.append(row_dict)
        else:
            # Summary/matrix: rows live under grouping keys like "0!T", "1!T", etc.
            for key, entry in fact_map.items():
                if not key.endswith("!T"):
                    continue
                for row in entry.get("rows", []):
                    cells = row.get("dataCells", [])
                    col_names = report_metadata.get("detailColumns", [])
                    row_dict = {}
                    for i, col in enumerate(col_names):
                        if i < len(cells):
                            cell = cells[i]
                            row_dict[label_map.get(col, col)] = cell.get("label") or cell.get("value")
                    rows.append(row_dict)

        return rows

    def is_configured(self) -> bool:
        """True if username and password are set."""
        return bool(
            (self.username or os.getenv("SALESFORCE_USERNAME"))
            and (self.password or os.getenv("SALESFORCE_PASSWORD"))
        )
