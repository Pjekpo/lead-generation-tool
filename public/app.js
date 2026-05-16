const SOURCE_LABEL = "Google Maps";
const LEAD_NOTES_STORAGE_KEY = "lead-generation-tool:lead-notes:v1";

const form = document.getElementById("leadForm");
const statusEl = document.getElementById("status");
const resultsBody = document.getElementById("resultsBody");
const submitBtn = document.getElementById("submitBtn");
const searchTermRows = document.getElementById("searchTermRows");
const addSearchTermBtn = document.getElementById("addSearchTermBtn");
const bulkEditBtn = document.getElementById("bulkEditBtn");
const removeEmptyBtn = document.getElementById("removeEmptyBtn");
const printLastRunBtn = document.getElementById("printLastRunBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const locationInput = document.getElementById("location");
const placesPerSearchInput = document.getElementById("placesPerSearch");
const leadNotes = loadLeadNotes();

addSearchTermBtn.addEventListener("click", () => {
  addSearchTermRow("");
});

bulkEditBtn.addEventListener("click", () => {
  const existingTerms = getSearchTermValues({ includeEmpty: true }).join("\n");
  const updatedTerms = window.prompt("Enter one search term per line.", existingTerms);
  if (updatedTerms === null) {
    return;
  }

  setSearchTermRows(
    updatedTerms
      .split(/\r?\n/)
      .map((term) => term.trim())
  );
});

removeEmptyBtn.addEventListener("click", () => {
  const terms = getSearchTermValues({ includeEmpty: false });
  setSearchTermRows(terms.length > 0 ? terms : [""]);
});

printLastRunBtn.addEventListener("click", printLastResults);
exportCsvBtn.addEventListener("click", exportLastResultsCsv);
resultsBody.addEventListener("input", handleLeadNoteInput);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const searchTerms = getSearchTermValues({ includeEmpty: false });
  const location = locationInput.value.trim();
  const placesPerSearch = toPositiveInt(placesPerSearchInput.value);
  const leadCount = searchTerms.length * placesPerSearch;

  const inputError = validateInputs({ searchTerms, location, placesPerSearch, leadCount });
  if (inputError) {
    setStatus(inputError, true);
    return;
  }

  setLoading(true);
  setStatus("Generating leads...");

  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location,
        leadCount,
        sourceOptions: {
          googleMapsSearchTerms: searchTerms,
          googleMapsLocationQuery: location,
          googleMapsMaxCrawledPlacesPerSearch: placesPerSearch,
          googleMapsLanguage: "en",
        },
      }),
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }

    renderLeads(payload.leads || []);

    const meta = payload.meta || {};
    const warningText = (meta.warnings || []).length
      ? ` Warnings: ${(meta.warnings || []).join(" | ")}`
      : "";
    setStatus(
      `Returned ${meta.returnedLeads || 0}/${meta.requestedLeads || leadCount} leads. Source: ${SOURCE_LABEL}.${warningText}`
    );
  } catch (error) {
    setStatus(error.message || "Unable to generate leads.", true);
    renderLeads([]);
  } finally {
    setLoading(false);
  }
});

addSearchTermRow("restaurant");

async function printLastResults() {
  setUtilityLoading(true);
  setStatus("Loading saved results...");

  try {
    const response = await fetch("/api/leads/last");
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || "Unable to load saved results.");
    }

    const leads = payload.leads || [];
    renderLeads(leads);
    const savedAt = payload.savedAt ? ` Saved: ${formatDateTime(payload.savedAt)}.` : "";
    setStatus(`Printed ${leads.length} saved leads.${savedAt}`);
  } catch (error) {
    setStatus(error.message || "Unable to load saved results.", true);
  } finally {
    setUtilityLoading(false);
  }
}

async function exportLastResultsCsv() {
  setUtilityLoading(true);
  setStatus("Preparing CSV export...");

  try {
    const response = await fetch("/api/leads/last.csv");
    if (!response.ok) {
      const payload = await parseJsonResponse(response);
      throw new Error(payload.error || "Unable to export saved results.");
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = getDownloadFilename(response.headers.get("Content-Disposition"));
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    setStatus("CSV export ready.");
  } catch (error) {
    setStatus(error.message || "Unable to export saved results.", true);
  } finally {
    setUtilityLoading(false);
  }
}

function addSearchTermRow(value) {
  const row = document.createElement("div");
  row.className = "search-term-row";

  const rowNumber = document.createElement("span");
  rowNumber.className = "search-term-number";

  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = "restaurant";
  input.className = "search-term-input";
  input.addEventListener("input", updateSearchTermState);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "remove-term-btn";
  removeButton.setAttribute("aria-label", "Remove search term");
  removeButton.textContent = "x";
  removeButton.addEventListener("click", () => {
    if (searchTermRows.children.length === 1) {
      input.value = "";
    } else {
      row.remove();
    }
    updateSearchTermState();
  });

  row.append(rowNumber, input, removeButton);
  searchTermRows.append(row);
  input.focus();
  updateSearchTermState();
}

function setSearchTermRows(values) {
  searchTermRows.innerHTML = "";
  const safeValues = values.length > 0 ? values : [""];
  for (const value of safeValues) {
    addSearchTermRow(value);
  }
  updateSearchTermState();
}

function updateSearchTermState() {
  const rows = Array.from(searchTermRows.querySelectorAll(".search-term-row"));
  rows.forEach((row, index) => {
    const rowNumber = row.querySelector(".search-term-number");
    rowNumber.textContent = String(index + 1);
  });

  const hasEmptyRows = getSearchTermValues({ includeEmpty: true }).some((term) => !term);
  removeEmptyBtn.disabled = !hasEmptyRows;
}

function getSearchTermValues({ includeEmpty }) {
  const inputs = Array.from(searchTermRows.querySelectorAll(".search-term-input"));
  return inputs
    .map((input) => input.value.trim())
    .filter((term) => includeEmpty || Boolean(term));
}

function validateInputs({ searchTerms, location, placesPerSearch, leadCount }) {
  if (searchTerms.length === 0) {
    return "Add at least one search term.";
  }
  if (!location) {
    return "Location is required.";
  }
  if (!Number.isInteger(placesPerSearch) || placesPerSearch < 1) {
    return "Number of places must be at least 1.";
  }
  if (leadCount > 500) {
    return "Total requested places cannot exceed 500.";
  }
  return "";
}

function renderLeads(leads) {
  if (!Array.isArray(leads) || leads.length === 0) {
    resultsBody.innerHTML = '<tr><td colspan="8" class="placeholder">No leads found for this request.</td></tr>';
    return;
  }

  const rows = leads
    .map((lead, index) => {
      const sourceUrlCell = renderSourceLink(lead.sourceUrl);
      const needsWebsite = Boolean(lead.needsWebsite);
      const websiteStatus = lead.websiteStatus || (needsWebsite ? "No website found" : "Proper website");
      const websiteCell = websiteStatus === "No website found"
        ? '<span class="missing-website">No website found</span>'
        : renderSourceLink(lead.website);
      const noteKey = getLeadNoteKey(lead);
      const savedNote = leadNotes[noteKey] || "";

      return `
        <tr class="${needsWebsite ? "needs-website-row" : ""}">
          <td class="number-cell">${index + 1}</td>
          <td>${escapeHtml(lead.companyName || "N/A")}</td>
          <td>${escapeHtml(lead.phoneNumber || "N/A")}</td>
          <td>${escapeHtml(lead.type || "N/A")}</td>
          <td>${escapeHtml(lead.address || "N/A")}</td>
          <td class="url-cell">${websiteCell}</td>
          <td class="url-cell">${sourceUrlCell}</td>
          <td class="notes-cell">
            <textarea
              class="lead-note-input"
              data-note-key="${escapeHtml(noteKey)}"
              rows="3"
              placeholder="Call notes"
            >${escapeHtml(savedNote)}</textarea>
          </td>
        </tr>
      `;
    })
    .join("");

  resultsBody.innerHTML = rows;
}

function handleLeadNoteInput(event) {
  const input = event.target;
  if (!input.classList.contains("lead-note-input")) {
    return;
  }

  const noteKey = input.dataset.noteKey;
  if (!noteKey) {
    return;
  }

  const note = input.value.trim();
  if (note) {
    leadNotes[noteKey] = input.value;
  } else {
    delete leadNotes[noteKey];
  }
  saveLeadNotes();
}

function getLeadNoteKey(lead) {
  return [
    lead.companyName,
    lead.phoneNumber,
    lead.address,
    lead.sourceUrl,
  ]
    .map(normalizeNoteKeyPart)
    .filter(Boolean)
    .join("|");
}

function normalizeNoteKeyPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+@:/?.&=# -]/g, "");
}

function loadLeadNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEAD_NOTES_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveLeadNotes() {
  try {
    localStorage.setItem(LEAD_NOTES_STORAGE_KEY, JSON.stringify(leadNotes));
  } catch (error) {
    console.warn("Unable to save lead note.", error);
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? "Working..." : "Generate Leads";
  printLastRunBtn.disabled = isLoading;
  exportCsvBtn.disabled = isLoading;
}

function setUtilityLoading(isLoading) {
  printLastRunBtn.disabled = isLoading;
  exportCsvBtn.disabled = isLoading;
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

function getDownloadFilename(disposition) {
  const fallback = "lead-results.csv";
  const match = String(disposition || "").match(/filename="?([^"]+)"?/i);
  return match && match[1] ? match[1] : fallback;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
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
