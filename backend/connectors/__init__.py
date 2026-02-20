"""
Connectors to external systems (Google Sheets, Salesforce, QuickBooks, etc.).
Each connector fetches data and the sync layer writes it into app tables.
"""
from .google_sheets import GoogleSheetsConnector
from .salesforce import SalesforceConnector
from .quickbooks import QuickBooksConnector

__all__ = ["GoogleSheetsConnector", "SalesforceConnector", "QuickBooksConnector"]
