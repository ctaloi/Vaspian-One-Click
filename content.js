// Content script for Vaspian One Click
// Detects phone numbers on web pages and makes them clickable

(function() {
  'use strict';

  // Phone number regex patterns
  const phonePatterns = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,           // 123-456-7890, 123.456.7890, 123 456 7890
    /\b\(\d{3}\)\s?\d{3}[-.\s]?\d{4}\b/g,          // (123) 456-7890
    /\b\d{10,15}\b/g,                                // 1234567890, 817169212120
    /\+\d{1,3}\s?\d{10,14}\b/g                       // +1 1234567890
  ];

  /**
   * Initialize the click-to-call functionality
   */
  function init() {
    // Find and wrap phone numbers
    wrapPhoneNumbers();

    // Watch for dynamic content changes
    observePageChanges();
  }

  /**
   * Check if an element or its ancestors have a Vaspian class
   * @param {Element} element
   * @returns {boolean}
   */
  function isVaspianElement(element) {
    let current = element;
    while (current && current !== document.body) {
      if (current.classList && (
          current.classList.contains('vaspian-phone') ||
          current.classList.contains('vaspian-notification') ||
          current.classList.contains('vaspian-notification-content') ||
          current.classList.contains('vaspian-notification-body')
      )) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Find phone numbers in the page and make them clickable
   */
  function wrapPhoneNumbers() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          // Skip script and style tags, and our own elements
          if (node.parentElement.tagName === 'SCRIPT' ||
              node.parentElement.tagName === 'STYLE' ||
              isVaspianElement(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodesToReplace = [];
    let node;

    while (node = walker.nextNode()) {
      const text = node.nodeValue;
      let hasPhone = false;

      // Check if text contains any phone number pattern
      for (const pattern of phonePatterns) {
        if (pattern.test(text)) {
          hasPhone = true;
          break;
        }
      }

      if (hasPhone) {
        nodesToReplace.push(node);
      }
    }

    // Replace text nodes with clickable phone numbers
    nodesToReplace.forEach(replacePhoneNumbers);
  }

  /**
   * Replace phone numbers in a text node with clickable elements
   * @param {Node} textNode
   */
  function replacePhoneNumbers(textNode) {
    const text = textNode.nodeValue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let matches = [];

    // Find all phone number matches
    phonePatterns.forEach(pattern => {
      const regex = new RegExp(pattern);
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          text: match[0],
          index: match.index
        });
      }
    });

    // Remove duplicates and sort by index
    matches = matches
      .filter((match, index, self) =>
        index === self.findIndex(m => m.index === match.index)
      )
      .sort((a, b) => a.index - b.index);

    // Create the fragment with clickable phone numbers
    matches.forEach(match => {
      // Add text before the phone number
      if (match.index > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.substring(lastIndex, match.index))
        );
      }

      // Create clickable phone number element
      const phoneLink = createPhoneLink(match.text);
      fragment.appendChild(phoneLink);

      lastIndex = match.index + match.text.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    // Replace the text node with the fragment
    if (matches.length > 0) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  /**
   * Create a clickable phone number element
   * @param {string} phoneNumber
   * @returns {HTMLElement}
   */
  function createPhoneLink(phoneNumber) {
    const span = document.createElement('span');
    span.textContent = phoneNumber;
    span.className = 'vaspian-phone';
    span.title = `Click to call ${phoneNumber}`;
    span.style.cursor = 'pointer';
    span.style.textDecoration = 'underline';
    span.style.color = '#E66825';

    span.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      makeCall(phoneNumber);
    });

    span.addEventListener('mouseenter', () => {
      span.style.color = '#E89029';
    });

    span.addEventListener('mouseleave', () => {
      span.style.color = '#E66825';
    });

    return span;
  }

  /**
   * Format phone number for display
   * @param {string} phoneNumber
   * @returns {string}
   */
  function formatPhoneForDisplay(phoneNumber) {
    // Remove all non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\+/g, '');
    const hasPlus = cleaned.startsWith('+');

    if (hasPlus && digits.length >= 11) {
      // International: +1 (555) 123-4567
      return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      // US: (555) 123-4567
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    // Return as-is if doesn't match expected format
    return phoneNumber;
  }

  /**
   * Initiate a call to the phone number
   * @param {string} phoneNumber
   */
  async function makeCall(phoneNumber) {
    // Clean the phone number (remove formatting, but keep +)
    const cleanNumber = phoneNumber.replace(/[\s.\-()]/g, '');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'makeCall',
        phoneNumber: cleanNumber
      });

      if (response && response.success) {
        // Format the phone number for display
        const formattedNumber = formatPhoneForDisplay(cleanNumber);
        showNotification(`Calling ${formattedNumber}...`, 'success', response.extension);
      } else if (response && response.error) {
        showNotification(`${response.error}`, 'error');
      } else {
        showNotification('No response from extension', 'error');
      }
    } catch (error) {
      console.error('Error making call:', error);
      showNotification(`Failed to initiate call: ${error.message || 'Unknown error'}`, 'error');
    }
  }

  /**
   * Show a notification to the user
   * @param {string} message
   * @param {string} type
   * @param {string} extension - Optional user extension number
   */
  function showNotification(message, type, extension = null) {
    const notification = document.createElement('div');
    notification.className = `vaspian-notification vaspian-notification-${type}`;

    // Parse the message to extract phone number if present
    let title = message;
    let phoneNumber = '';

    // Check if message contains "Calling " pattern
    const callingMatch = message.match(/^Calling (.+?)\.\.\.$/);
    if (callingMatch) {
      phoneNumber = callingMatch[1];
      title = extension ? `Calling ${phoneNumber} from ${extension}` : `Calling ${phoneNumber}`;
    }

    // Create notification structure
    const content = document.createElement('div');
    content.className = 'vaspian-notification-content';

    // Icon
    const icon = document.createElement('div');
    icon.className = 'vaspian-notification-icon';

    if (type === 'success') {
      icon.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      `;
    } else {
      icon.innerHTML = `
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      `;
    }

    // Body
    const body = document.createElement('div');
    body.className = 'vaspian-notification-body';

    if (phoneNumber) {
      // Show single line message
      const titleEl = document.createElement('div');
      titleEl.className = 'vaspian-notification-number';
      titleEl.textContent = title;
      titleEl.style.fontSize = '16px';
      titleEl.style.marginBottom = '0';

      body.appendChild(titleEl);
    } else {
      // Just show the message
      const titleEl = document.createElement('div');
      titleEl.className = 'vaspian-notification-title';
      titleEl.textContent = message;
      titleEl.style.marginBottom = '0';

      body.appendChild(titleEl);
    }

    content.appendChild(icon);
    content.appendChild(body);
    notification.appendChild(content);

    document.body.appendChild(notification);

    // Remove notification after 3 seconds
    setTimeout(() => {
      notification.style.animation = 'vaspian-slide-out 0.3s ease-in forwards';
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, 3000);
  }

  /**
   * Observe page changes and wrap new phone numbers
   */
  function observePageChanges() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Process the new element
              const walker = document.createTreeWalker(
                node,
                NodeFilter.SHOW_TEXT,
                {
                  acceptNode: function(n) {
                    if (n.parentElement.tagName === 'SCRIPT' ||
                        n.parentElement.tagName === 'STYLE' ||
                        isVaspianElement(n.parentElement)) {
                      return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                  }
                }
              );

              const nodesToReplace = [];
              let textNode;

              while (textNode = walker.nextNode()) {
                const text = textNode.nodeValue;
                let hasPhone = false;

                for (const pattern of phonePatterns) {
                  if (pattern.test(text)) {
                    hasPhone = true;
                    break;
                  }
                }

                if (hasPhone) {
                  nodesToReplace.push(textNode);
                }
              }

              nodesToReplace.forEach(replacePhoneNumbers);
            }
          });
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initialize when the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
