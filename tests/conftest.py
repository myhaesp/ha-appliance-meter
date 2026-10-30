import pytest
@pytest.fixture(autouse=True)
def custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def accounting_currency(hass):
    hass.config.currency = "DKK"
