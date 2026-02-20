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

    def is_configured(self) -> bool:
        """True if username and password are set."""
        return bool(
            (self.username or os.getenv("SALESFORCE_USERNAME"))
            and (self.password or os.getenv("SALESFORCE_PASSWORD"))
        )
