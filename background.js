// Background service worker for Vaspian One Click

// Logging system
const MAX_LOGS = 500;
let logs = [];
let loggingEnabled = false;
let sidebarEnabled = false;
let isLoggedIn = false;

// Set default preferences on first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Set defaults on first install
    await chrome.storage.sync.set({
      useSidebar: true,
      debugLogging: false,
      dialPrefix: '8'
    });
    sidebarEnabled = true;
    updateActionBehavior();
  } else {
    // On update or other reasons, load existing preferences
    loadPreferences();
  }
});

// Load logging and sidebar preferences on startup
loadPreferences();

function loadPreferences() {
  chrome.storage.sync.get(['debugLogging', 'useSidebar', 'isLoggedIn'], (result) => {
    loggingEnabled = result.debugLogging || false;
    sidebarEnabled = result.useSidebar !== undefined ? result.useSidebar : true;
    isLoggedIn = result.isLoggedIn || false;
    updateActionBehavior();
  });
}

async function addLog(level, message, details = null) {
  // Skip logging if disabled (except for errors)
  if (!loggingEnabled && level !== 'error') {
    return;
  }

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level, // 'info', 'success', 'warning', 'error'
    message,
    details
  };

  logs.push(logEntry);

  // Keep only the last MAX_LOGS entries
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(-MAX_LOGS);
  }

  // Store logs
  await chrome.storage.local.set({ logs });

  // Also log to console
  const consoleMsg = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(consoleMsg, details || '');
  } else if (level === 'warning') {
    console.warn(consoleMsg, details || '');
  } else {
    console.log(consoleMsg, details || '');
  }

  // Notify popup if open
  try {
    chrome.runtime.sendMessage({ action: 'logUpdate', log: logEntry });
  } catch (e) {
    // Popup not open, ignore
  }
}

// Load existing logs on startup
chrome.storage.local.get(['logs'], (result) => {
  if (result.logs) {
    logs = result.logs;
  }
});

// Flush old logs periodically (every hour, keep logs from last 24 hours)
const FLUSH_INTERVAL = 60 * 60 * 1000; // 1 hour
const LOG_RETENTION = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  flushOldLogs();
}, FLUSH_INTERVAL);

// Also flush on startup
flushOldLogs();

/**
 * Remove logs older than LOG_RETENTION period
 */
async function flushOldLogs() {
  const now = Date.now();
  const cutoffTime = now - LOG_RETENTION;

  // Filter out old logs
  const originalCount = logs.length;
  logs = logs.filter(log => {
    const logTime = new Date(log.timestamp).getTime();
    return logTime > cutoffTime;
  });

  const removedCount = originalCount - logs.length;

  if (removedCount > 0) {
    await chrome.storage.local.set({ logs });
    addLog('info', `Flushed ${removedCount} old log entries (keeping last 24 hours)`);
  }
}

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'makeCall') {
    addLog('info', `Call request received for: ${request.phoneNumber}`);
    handleClickToCall(request.phoneNumber)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  } else if (request.action === 'getLogs') {
    sendResponse({ logs });
    return true;
  } else if (request.action === 'clearLogs') {
    logs = [];
    chrome.storage.local.set({ logs: [] });
    addLog('info', 'Logs cleared');
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'setLogging') {
    loggingEnabled = request.enabled;
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'setSidebarMode') {
    sidebarEnabled = request.enabled;
    updateActionBehavior();
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'getCallHistory') {
    chrome.storage.local.get(['callHistory'], (result) => {
      sendResponse({ callHistory: result.callHistory || [] });
    });
    return true;
  } else if (request.action === 'clearCallHistory') {
    chrome.storage.local.set({ callHistory: [] });
    addLog('info', 'Call history cleared');
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'logout') {
    handleLogout()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (request.action === 'getLoginStatus') {
    sendResponse({ isLoggedIn });
    return true;
  } else if (request.action === 'testLogin') {
    testLogin(request.tenant, request.extension, request.password)
      .then(result => sendResponse({ success: true, isValid: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (request.action === 'updateCallNote') {
    updateCallNote(request.phoneNumber, request.timestamp, request.note)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

/**
 * Main function to handle click-to-call
 * @param {string} phoneNumber - The destination phone number
 */
async function handleClickToCall(phoneNumber) {
  try {
    addLog('info', `Starting click-to-call for: ${phoneNumber}`);

    // Get stored credentials and prefix
    const settings = await chrome.storage.sync.get(['tenant', 'extension', 'password', 'dialPrefix']);
    addLog('info', `Retrieved settings: tenant=${settings.tenant}, extension=${settings.extension}, prefix=${settings.dialPrefix || 'none'}`);

    if (!settings.tenant || !settings.extension || !settings.password) {
      const error = 'Please configure your Vaspian credentials in the extension popup';
      addLog('error', error);
      throw new Error(error);
    }

    // Step 1: Login to get session cookie
    addLog('info', 'Attempting login to Vaspian...');
    const loginSuccess = await login(settings.tenant, settings.extension, settings.password);

    if (!loginSuccess) {
      const error = 'Login failed. Please check your credentials.';
      addLog('error', error);
      throw new Error(error);
    }

    addLog('success', 'Login successful');

    // Mark as logged in
    isLoggedIn = true;
    await chrome.storage.sync.set({ isLoggedIn: true });

    // Apply prefix if configured
    const prefixedNumber = settings.dialPrefix ? `${settings.dialPrefix}${phoneNumber}` : phoneNumber;
    addLog('info', `Initiating call to: ${prefixedNumber} (original: ${phoneNumber}) from extension: ${settings.extension}`);

    // Step 2: Make the click-to-call request
    const callResult = await makeCall(settings.extension, prefixedNumber);

    addLog('success', `Call successfully initiated to ${phoneNumber}`);

    // Step 3: Add to call history
    await addToCallHistory(phoneNumber);

    return {
      ...callResult,
      extension: settings.extension
    };
  } catch (error) {
    addLog('error', `Click-to-call failed: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Add a call to the click history
 * @param {string} phoneNumber - The phone number that was called
 * @param {string} note - Optional note for the call
 */
async function addToCallHistory(phoneNumber, note = '') {
  try {
    const result = await chrome.storage.local.get(['callHistory']);
    let callHistory = result.callHistory || [];

    // Add new call with timestamp and note
    callHistory.unshift({
      phoneNumber,
      timestamp: new Date().toISOString(),
      note: note
    });

    // Keep only last 500 calls
    callHistory = callHistory.slice(0, 500);

    await chrome.storage.local.set({ callHistory });
    addLog('info', `Added ${phoneNumber} to call history`);
  } catch (error) {
    addLog('error', `Failed to save call history: ${error.message}`);
  }
}

/**
 * Login to Vaspian system
 * @param {string} tenant - Tenant name (e.g., "sandbox")
 * @param {string} extension - User extension/ID
 * @param {string} password - User password
 * @returns {Promise<boolean>}
 */
async function login(tenant, extension, password) {
  const loginUrl = `https://xtone.buf.vaspian.net/webadmin/en/user/jsp/ProcessLogin.jsp?tenantWebName=/${tenant}&UserID=${extension}&Password=${encodeURIComponent(password)}`;

  addLog('info', `Login URL: ${loginUrl.replace(/Password=[^&]+/, 'Password=***')}`);

  try {
    // Check cookies before login
    const cookiesBefore = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    addLog('info', `Cookies before login: ${cookiesBefore.length} cookies`);
    if (cookiesBefore.length > 0) {
      addLog('info', `Cookie names: ${cookiesBefore.map(c => c.name).join(', ')}`);
    }

    addLog('info', 'Sending login request...');
    const response = await fetch(loginUrl, {
      method: 'POST',
      credentials: 'include', // Important: this maintains cookies
      redirect: 'follow'
    });

    addLog('info', `Login response: ${response.status} ${response.statusText}`);
    addLog('info', `Response URL: ${response.url}`);

    // Check cookies after login
    const cookiesAfter = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    addLog('info', `Cookies after login: ${cookiesAfter.length} cookies`);
    if (cookiesAfter.length > 0) {
      addLog('info', `Cookie names: ${cookiesAfter.map(c => c.name).join(', ')}`);
      cookiesAfter.forEach(cookie => {
        addLog('info', `Cookie ${cookie.name}: value=${cookie.value.substring(0, 20)}..., path=${cookie.path}, secure=${cookie.secure}, httpOnly=${cookie.httpOnly}`);
      });
    }

    // Read response body for debugging
    const responseText = await response.text();
    if (responseText && responseText.length > 0) {
      addLog('info', `Login response body (${responseText.length} chars): ${responseText}`);
    } else {
      addLog('info', 'Login response body: (empty)');
    }

    if (!response.ok) {
      addLog('error', `Login failed with status: ${response.status} ${response.statusText}`);
      return false;
    }

    addLog('success', 'Login request completed successfully');
    return true;
  } catch (error) {
    addLog('error', `Login network error: ${error.message}`, error.stack);
    return false;
  }
}

/**
 * Make a click-to-call request
 * @param {string} origExt - Origin extension (your extension)
 * @param {string} destExt - Destination extension/phone number
 * @returns {Promise<object>}
 */
async function makeCall(origExt, destExt) {
  const callUrl = `https://xtone.buf.vaspian.net/webadmin/en/user/jsp/ProcessClickToCall.jsp?origExt=${origExt}&destExt=${destExt}`;

  addLog('info', `Call URL: ${callUrl}`);

  try {
    // Check cookies before call
    const cookiesBefore = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    addLog('info', `Cookies before call: ${cookiesBefore.length} cookies`);
    if (cookiesBefore.length > 0) {
      addLog('info', `Cookie names: ${cookiesBefore.map(c => c.name).join(', ')}`);
    } else {
      addLog('warning', 'No cookies found! This will likely fail.');
    }

    addLog('info', 'Sending click-to-call request...');
    const response = await fetch(callUrl, {
      method: 'POST',
      credentials: 'include', // Use cookies from login
      redirect: 'follow'
    });

    addLog('info', `Call response: ${response.status} ${response.statusText}`);
    addLog('info', `Response URL: ${response.url}`);

    // Read response headers
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    addLog('info', `Response headers: ${JSON.stringify(headers)}`);

    const result = await response.text();
    if (result && result.length > 0) {
      addLog('info', `Call response body (${result.length} chars): ${result}`);
    } else {
      addLog('info', 'Call response body: (empty)');
    }

    if (!response.ok) {
      const error = `Call failed: ${response.status} ${response.statusText}`;
      addLog('error', error);
      throw new Error(error);
    }

    // Check if we got redirected to login (would indicate session expired)
    if (response.url.includes('ProcessLogin') || response.url.includes('login')) {
      const error = 'Session expired or cookies not sent properly';
      addLog('error', error);
      throw new Error(error);
    }

    addLog('success', `Call request completed successfully`);

    return {
      success: true,
      message: 'Call initiated',
      destination: destExt,
      response: result
    };
  } catch (error) {
    addLog('error', `Call network error: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Handle extension icon clicks (only for sidebar mode)
 */
function handleActionClick(tab) {
  if (sidebarEnabled) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

// Set up the click listener once
chrome.action.onClicked.addListener(handleActionClick);

/**
 * Update the action behavior based on sidebar preference
 */
function updateActionBehavior() {
  if (sidebarEnabled) {
    // When sidebar is enabled, disable the popup and use the click listener
    chrome.action.setPopup({ popup: '' });
  } else {
    // When sidebar is disabled, enable the popup (click listener is ignored)
    chrome.action.setPopup({ popup: 'popup.html' });
  }
}

/**
 * Test login credentials
 * @param {string} tenant - Tenant name
 * @param {string} extension - User extension/ID
 * @param {string} password - User password
 * @returns {Promise<boolean>}
 */
async function testLogin(tenant, extension, password) {
  try {
    addLog('info', 'Testing login credentials...');

    const loginSuccess = await login(tenant, extension, password);

    if (loginSuccess) {
      addLog('success', 'Credential test successful');
      isLoggedIn = true;
      await chrome.storage.sync.set({ isLoggedIn: true });
      return true;
    } else {
      addLog('error', 'Credential test failed');
      isLoggedIn = false;
      await chrome.storage.sync.set({ isLoggedIn: false });
      return false;
    }
  } catch (error) {
    addLog('error', `Credential test error: ${error.message}`, error.stack);
    isLoggedIn = false;
    await chrome.storage.sync.set({ isLoggedIn: false });
    return false;
  }
}

/**
 * Handle logout - clear cookies and session state
 */
async function handleLogout() {
  try {
    addLog('info', 'Logging out...');

    // Clear all cookies for the Vaspian domain
    const cookies = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });

    for (const cookie of cookies) {
      await chrome.cookies.remove({
        url: `https://${cookie.domain}${cookie.path}`,
        name: cookie.name
      });
      addLog('info', `Removed cookie: ${cookie.name}`);
    }

    // Get current dialPrefix to preserve it
    const settings = await chrome.storage.sync.get(['dialPrefix']);

    // Clear credentials but preserve dialPrefix (including empty string for "no prefix")
    await chrome.storage.sync.set({
      tenant: '',
      extension: '',
      password: '',
      dialPrefix: settings.dialPrefix !== undefined ? settings.dialPrefix : '8',  // Preserve current setting or default to '8'
      isLoggedIn: false
    });

    // Clear click history
    await chrome.storage.local.set({ callHistory: [] });

    // Mark as logged out
    isLoggedIn = false;

    addLog('success', 'Logged out successfully - credentials and history cleared');
  } catch (error) {
    addLog('error', `Logout failed: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Update the note for a specific call identified by phone number and timestamp
 * @param {string} phoneNumber - The phone number
 * @param {string} timestamp - The call timestamp (unique identifier)
 * @param {string} note - The note to add
 */
async function updateCallNote(phoneNumber, timestamp, note) {
  try {
    const result = await chrome.storage.local.get(['callHistory']);
    let callHistory = result.callHistory || [];

    // Find the specific call using both phone number and timestamp
    const callIndex = callHistory.findIndex(call =>
      call.phoneNumber === phoneNumber && call.timestamp === timestamp
    );

    if (callIndex !== -1) {
      callHistory[callIndex].note = note;
      await chrome.storage.local.set({ callHistory });
      addLog('info', `Updated note for call to ${phoneNumber} at ${timestamp}`);
    } else {
      addLog('warning', `Could not find call to ${phoneNumber} at ${timestamp} to update note`);
    }
  } catch (error) {
    addLog('error', `Failed to update call note: ${error.message}`);
    throw error;
  }
}
