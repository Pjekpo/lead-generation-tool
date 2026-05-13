const SOURCE_LABEL = "Google Maps";

const form = document.getElementById("leadForm");
const statusEl = document.getElementById("status");
const resultsBody = document.getElementById("resultsBody");
const submitBtn = document.getElementById("submitBtn");
const searchTermRows = document.getElementById("searchTermRows");
const addSearchTermBtn = document.getElementById("addSearchTermBtn");
const bulkEditBtn = document.getElementById("bulkEditBtn");
const removeEmptyBtn = document.getElementById("removeEmptyBtn");
const locationInput = document.getElementById("location");
const placesPerSearchInput = document.getElementById("placesPerSearch");

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
      `Returned ${meta.returnedLeads || 0}/${meta.requestedLeads || leadCount} leads. Qualified: ${
        meta.qualifiedLeads || 0
      }. Source: ${SOURCE_LABEL}.${warningText}`
    );
  } catch (error) {
    setStatus(error.message || "Unable to generate leads.", true);
    renderLeads([]);
  } finally {
    setLoading(false);
  }
});

addSearchTermRow("restaurant");

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
    resultsBody.innerHTML = '<tr><td colspan="9" class="placeholder">No leads found for this request.</td></tr>';
    return;
  }

  const rows = leads
    .map((lead) => {
      const websiteCell = renderSourceLink(lead.website);
      const sourceUrlCell = renderSourceLink(lead.sourceUrl);
      const needsWebsite = Boolean(lead.needsWebsite);

      return `
        <tr class="${needsWebsite ? "needs-website-row" : ""}">
          <td>${escapeHtml(lead.companyName || "N/A")}</td>
          <td>${escapeHtml(lead.phoneNumber || "N/A")}</td>
          <td>${escapeHtml(lead.type || "N/A")}</td>
          <td>${escapeHtml(lead.address || "N/A")}</td>
          <td>${needsWebsite ? '<span class="flag-badge">Needs website</span>' : "No"}</td>
          <td class="url-cell">${needsWebsite ? '<span class="missing-website">No website found</span>' : websiteCell}</td>
          <td class="url-cell">${sourceUrlCell}</td>
          <td>${escapeHtml(String(lead.qualificationScore || 0))}</td>
          <td>${lead.qualified ? "Yes" : "No"}</td>
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

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? "Working..." : "Generate Leads";
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
