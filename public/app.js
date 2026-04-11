const ALLOWED_SOURCES = ["google_maps", "facebook"];
const SOURCE_LABELS = {
  google_maps: "Google Maps",
  facebook: "Facebook",
};

const authPanel = document.getElementById("authPanel");
const loginForm = document.getElementById("loginForm");
const loginUsernameInput = document.getElementById("loginUsername");
const loginPasswordInput = document.getElementById("loginPassword");
const loginStatusEl = document.getElementById("loginStatus");
const loginBtn = document.getElementById("loginBtn");
const authStatePill = document.getElementById("authStatePill");
const logoutBtn = document.getElementById("logoutBtn");

const form = document.getElementById("leadForm");
const statusEl = document.getElementById("status");
const resultsBody = document.getElementById("resultsBody");
const submitBtn = document.getElementById("submitBtn");

const companyTypeInput = document.getElementById("companyType");
const useCompanyTypeToggle = document.getElementById("useCompanyType");

const sourceGate = document.getElementById("sourceGate");
const appSections = document.getElementById("appSections");
const openSourcePickerBtn = document.getElementById("openSourcePickerBtn");
const selectedSourceLabel = document.getElementById("selectedSourceLabel");
const changeSourceBtn = document.getElementById("changeSourceBtn");
const sourceModal = document.getElementById("sourceModal");
const closeSourceModalBtn = document.getElementById("closeSourceModalBtn");
const sourceChoiceButtons = document.querySelectorAll(".source-choice");

const sourceOptionsFieldset = document.getElementById("sourceOptionsFieldset");
const googleMapsOptions = document.getElementById("googleMapsOptions");
const facebookOptions = document.getElementById("facebookOptions");

let selectedSource = "";
let authConfigured = false;
let authenticated = false;
let authenticatedUsername = "";

useCompanyTypeToggle.addEventListener("change", syncCompanyTypeToggle);
openSourcePickerBtn.addEventListener("click", openSourceModal);
changeSourceBtn.addEventListener("click", openSourceModal);
closeSourceModalBtn.addEventListener("click", closeSourceModal);
loginForm.addEventListener("submit", handleLoginSubmit);
logoutBtn.addEventListener("click", handleLogoutClick);

sourceModal.addEventListener("click", (event) => {
  if (event.target === sourceModal) {
    closeSourceModal();
  }
});

for (const button of sourceChoiceButtons) {
  button.addEventListener("click", () => {
    const source = button.getAttribute("data-source");
    if (!source) {
      return;
    }
    setSelectedSource(source);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!authenticated) {
    setStatus("Sign in before generating leads.", true);
    updateWorkspaceVisibility();
    loginPasswordInput.focus();
    return;
  }

  if (!selectedSource) {
    setStatus("Choose a source first.", true);
    openSourceModal();
    return;
  }

  const useCompanyType = useCompanyTypeToggle.checked;
  const companyType = useCompanyType ? companyTypeInput.value.trim() : "";
  const serviceNeed = document.getElementById("serviceNeed").value.trim();
  const location = document.getElementById("location").value.trim();
  const timeWindow = document.getElementById("timeWindow").value;
  const sourceOptions = {
    googleMapsSearchTerms: parseList(document.getElementById("googleMapsSearchTerms").value),
    googleMapsLocationQuery: document.getElementById("googleMapsLocationQuery").value.trim(),
    googleMapsMaxCrawledPlacesPerSearch: toPositiveInt(
      document.getElementById("googleMapsMaxCrawledPlacesPerSearch").value
    ),
    googleMapsLanguage: document.getElementById("googleMapsLanguage").value.trim() || "en",
    facebookStartUrls: parseUrlList(document.getElementById("facebookStartUrls").value),
    facebookResultsLimit: toPositiveInt(document.getElementById("facebookResultsLimit").value),
    facebookCaptionText: document.getElementById("facebookCaptionText").checked,
    facebookOnlyPostsNewerThan: document.getElementById("facebookOnlyPostsNewerThan").value.trim(),
    facebookOnlyPostsOlderThan: document.getElementById("facebookOnlyPostsOlderThan").value.trim(),
  };
  const leadCount = Number(document.getElementById("leadCount").value);
  const sources = [selectedSource];

  if (!Number.isInteger(leadCount) || leadCount < 1) {
    setStatus("Please provide a valid lead count.", true);
    return;
  }

  const sourceInputError = validateSourceInputs({
    selectedSource,
    companyType,
    serviceNeed,
    location,
    sourceOptions,
  });
  if (sourceInputError) {
    setStatus(sourceInputError, true);
    return;
  }

  setLoading(true);
  setStatus("Generating leads...");

  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyType,
        useCompanyType,
        serviceNeed,
        location,
        timeWindow,
        sourceOptions,
        leadCount,
        sources,
      }),
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 503) {
        await refreshAuthState();
      }
      throw new Error(payload.error || "Request failed.");
    }

    renderLeads(payload.leads || []);

    const meta = payload.meta || {};
    const warningText = (meta.warnings || []).length
      ? ` Warnings: ${(meta.warnings || []).join(" | ")}`
      : "";
    const timeText = meta.timeWindowLabel ? ` Time: ${meta.timeWindowLabel}.` : "";
    const sourceText = ` Source: ${SOURCE_LABELS[selectedSource]}.`;
    setStatus(
      `Returned ${meta.returnedLeads || 0}/${meta.requestedLeads || leadCount} leads. Qualified: ${
        meta.qualifiedLeads || 0
      }.${timeText}${sourceText}${warningText}`
    );
  } catch (error) {
    setStatus(error.message || "Unable to generate leads.", true);
    renderLeads([]);
  } finally {
    setLoading(false);
  }
});

syncCompanyTypeToggle();
syncSourceOptionVisibility();
updateWorkspaceVisibility();
void refreshAuthState();

function setSelectedSource(source) {
  if (!authenticated || !ALLOWED_SOURCES.includes(source)) {
    return;
  }

  selectedSource = source;
  selectedSourceLabel.textContent = `Source: ${SOURCE_LABELS[source] || source}`;
  updateWorkspaceVisibility();
  syncSourceOptionVisibility();
  closeSourceModal();
}

function syncSourceOptionVisibility() {
  const showGoogleMaps = selectedSource === "google_maps";
  const showFacebook = selectedSource === "facebook";

  googleMapsOptions.classList.toggle("hidden", !showGoogleMaps);
  facebookOptions.classList.toggle("hidden", !showFacebook);

  const showFieldset = showGoogleMaps || showFacebook;
  sourceOptionsFieldset.classList.toggle("hidden", !showFieldset);
}

function updateWorkspaceVisibility() {
  const showAuthenticatedWorkspace = authenticated && authConfigured;

  authPanel.classList.toggle("hidden", showAuthenticatedWorkspace);
  sourceGate.classList.toggle("hidden", !(showAuthenticatedWorkspace && !selectedSource));
  appSections.classList.toggle("hidden", !(showAuthenticatedWorkspace && Boolean(selectedSource)));

  if (!showAuthenticatedWorkspace) {
    closeSourceModal();
  }
}

async function refreshAuthState() {
  try {
    const response = await fetch("/api/auth/status", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || "Unable to check authentication status.");
    }

    authConfigured = Boolean(payload.configured);
    authenticated = Boolean(payload.authenticated);
    authenticatedUsername = payload.username || "";

    authStatePill.textContent = authenticatedUsername
      ? `Signed in as ${authenticatedUsername}`
      : "Signed in";
    authStatePill.classList.toggle("hidden", !authenticated);
    logoutBtn.classList.toggle("hidden", !authenticated);

    if (!authConfigured) {
      setLoginStatus("Set APP_ADMIN_PASSWORD on the server before using the app.", true);
      setLoginLoading(false);
    } else if (authenticated) {
      setLoginStatus("Signed in.", false);
      setStatus("Choose a source to start.");
      loginPasswordInput.value = "";
    } else {
      setLoginStatus("Sign in to unlock the app.", false);
      setStatus("Waiting for request.");
    }

    if (!authenticated) {
      selectedSource = "";
      selectedSourceLabel.textContent = "Source: Not selected";
      renderLeads([]);
    }

    syncSourceOptionVisibility();
    updateWorkspaceVisibility();
  } catch (error) {
    authConfigured = false;
    authenticated = false;
    authenticatedUsername = "";
    authStatePill.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    selectedSource = "";
    selectedSourceLabel.textContent = "Source: Not selected";
    updateWorkspaceVisibility();
    setLoginLoading(false);
    setLoginStatus(error.message || "Unable to check authentication status.", true);
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  if (!authConfigured && loginStatusEl.textContent.includes("APP_ADMIN_PASSWORD")) {
    return;
  }

  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value;

  if (!username || !password) {
    setLoginStatus("Enter your username and password.", true);
    return;
  }

  setLoginLoading(true);
  setLoginStatus("Signing in...");

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || "Sign-in failed.");
    }

    await refreshAuthState();
  } catch (error) {
    authenticated = false;
    updateWorkspaceVisibility();
    setLoginStatus(error.message || "Sign-in failed.", true);
  } finally {
    setLoginLoading(false);
  }
}

async function handleLogoutClick() {
  logoutBtn.disabled = true;

  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || "Logout failed.");
    }
  } catch (error) {
    setLoginStatus(error.message || "Logout failed.", true);
  } finally {
    selectedSource = "";
    selectedSourceLabel.textContent = "Source: Not selected";
    authenticated = false;
    authenticatedUsername = "";
    await refreshAuthState();
    logoutBtn.disabled = false;
  }
}

function openSourceModal() {
  if (!authenticated) {
    return;
  }
  sourceModal.classList.remove("hidden");
}

function closeSourceModal() {
  sourceModal.classList.add("hidden");
}

function renderLeads(leads) {
  if (!Array.isArray(leads) || leads.length === 0) {
    resultsBody.innerHTML = '<tr><td colspan="12" class="placeholder">No leads found for this request.</td></tr>';
    return;
  }

  const rows = leads
    .map((lead) => {
      const qualified = lead.qualified
        ? `Yes (${lead.qualificationScore || 0})`
        : `No (${lead.qualificationScore || 0})`;
      const personParts = [lead.personName, lead.username].filter(
        (value) => value && value !== "N/A"
      );
      const personValue = personParts.length ? personParts.join(" / ") : "N/A";
      const sentiment = lead.sentimentLabel
        ? `${capitalize(lead.sentimentLabel)} (${lead.sentimentScore || 0})`
        : "N/A";
      const sourceUrlCell = renderSourceLink(lead.sourceUrl || lead.postUrl);
      const sourceLabel = SOURCE_LABELS[lead.source] || lead.source || "N/A";

      return `
        <tr>
          <td>${escapeHtml(lead.companyName || "N/A")}</td>
          <td>${escapeHtml(personValue)}</td>
          <td>${escapeHtml(lead.phoneNumber || "N/A")}</td>
          <td>${escapeHtml(lead.type || "N/A")}</td>
          <td>${escapeHtml(lead.address || "N/A")}</td>
          <td>${escapeHtml(sourceLabel)}</td>
          <td class="url-cell">${sourceUrlCell}</td>
          <td>${escapeHtml(formatDate(lead.createdAt))}</td>
          <td>${escapeHtml(sentiment)}</td>
          <td>${escapeHtml(String(lead.intentScore || 0))}</td>
          <td class="content-cell">${escapeHtml(lead.impliedNeedContent || lead.postContent || "N/A")}</td>
          <td>${qualified}</td>
        </tr>
      `;
    })
    .join("");

  resultsBody.innerHTML = rows;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}

function setLoginStatus(message, isError = false) {
  loginStatusEl.textContent = message;
  loginStatusEl.className = isError ? "status error" : "status";
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? "Working..." : "Generate Leads";
}

function setLoginLoading(isLoading) {
  loginBtn.disabled = isLoading || !authConfigured;
  loginBtn.textContent = isLoading ? "Signing In..." : "Sign In";
}

function validateSourceInputs({ selectedSource, companyType, serviceNeed, location, sourceOptions }) {
  if (selectedSource === "google_maps") {
    const hasGoogleMapsSearchTerms =
      Array.isArray(sourceOptions.googleMapsSearchTerms) &&
      sourceOptions.googleMapsSearchTerms.length > 0;
    const effectiveLocation = sourceOptions.googleMapsLocationQuery || location;

    if (!effectiveLocation) {
      return "Google Maps needs a location or location query.";
    }
    if (!companyType && !serviceNeed && !hasGoogleMapsSearchTerms) {
      return "Google Maps needs at least one search term, company type, or service need.";
    }
  }

  if (selectedSource === "facebook") {
    if (!Array.isArray(sourceOptions.facebookStartUrls) || sourceOptions.facebookStartUrls.length === 0) {
      return "Facebook needs at least one public page or profile URL.";
    }
  }

  return "";
}

function parseList(value) {
  const items = String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items));
}

function parseUrlList(value) {
  return parseList(value)
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
}

function toPositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 0;
  }
  return parsed;
}

function renderSourceLink(rawUrl) {
  const normalized = normalizeDisplayUrl(rawUrl);
  if (!normalized) {
    return "N/A";
  }

  const label = truncate(normalized, 44);
  return `<a href="${escapeHtml(normalized)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function normalizeDisplayUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text || text === "N/A") {
    return "";
  }

  let candidate = text;
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  } else if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return "";
  } catch (error) {
    return "";
  }
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizeUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) {
    return "";
  }

  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  return `https://${text}`;
}

function syncCompanyTypeToggle() {
  const enabled = useCompanyTypeToggle.checked;
  companyTypeInput.disabled = !enabled;
  companyTypeInput.placeholder = enabled
    ? "e.g. Roofing contractor"
    : "Company type disabled";
}

function formatDate(rawDate) {
  if (!rawDate || rawDate === "N/A") {
    return "N/A";
  }

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    return rawDate;
  }

  return date.toLocaleString();
}

function capitalize(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}
