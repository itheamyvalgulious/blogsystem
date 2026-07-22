(() => {
  const storagePrefix = "__PROTECTED_CONTENT_STORAGE_PREFIX__";

  function decodeBase64(value) {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function parsePayload(root) {
    const payloadNode = root.querySelector("[data-protected-payload]");
    if (!payloadNode || !payloadNode.textContent) {
      throw new Error("Missing protected payload.");
    }
    return JSON.parse(payloadNode.textContent);
  }

  function readStoredPassword(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function persistPassword(key, password) {
    try {
      window.localStorage.setItem(key, password);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function clearStoredPassword(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function setStatus(root, message, tone) {
    const status = root.querySelector("[data-protected-status]");
    if (!status) {
      return;
    }

    status.textContent = message;
    if (tone) {
      status.dataset.tone = tone;
    } else {
      delete status.dataset.tone;
    }
  }

  function runEmbeddedScripts(container) {
    const scripts = Array.from(container.querySelectorAll("script"));
    for (const script of scripts) {
      const replacement = document.createElement("script");
      for (const attribute of script.attributes) {
        replacement.setAttribute(attribute.name, attribute.value);
      }
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }
  }

  async function deriveKey(password, salt, iterations, usages) {
    const encoder = new TextEncoder();
    const passwordKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
      {
        hash: "SHA-256",
        iterations,
        name: "PBKDF2",
        salt
      },
      passwordKey,
      {
        length: 256,
        name: "AES-GCM"
      },
      false,
      usages
    );
  }

  async function decryptPayload(password, payload) {
    if (!payload || payload.version !== __PROTECTED_CONTENT_VERSION__) {
      throw new Error("Unsupported protected content payload.");
    }

    const salt = decodeBase64(payload.salt);
    const iv = decodeBase64(payload.iv);
    const ciphertext = decodeBase64(payload.ciphertext);
    const key = await deriveKey(password, salt, payload.iterations, ["decrypt"]);
    const plaintext = await window.crypto.subtle.decrypt(
      {
        iv,
        name: "AES-GCM"
      },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plaintext);
  }

  async function unlock(root, password, persist) {
    const payload = parsePayload(root);
    const mount = root.querySelector("[data-protected-mount]");
    if (!mount) {
      throw new Error("Missing protected content mount point.");
    }

    setStatus(root, "Decrypting...", "");
    const html = await decryptPayload(password, payload);
    mount.innerHTML = html;
    mount.hidden = false;
    runEmbeddedScripts(mount);
    root.dataset.state = "unlocked";
    setStatus(root, "", "");

    const storageKey = root.dataset.storageKey || storagePrefix + window.location.pathname;
    if (persist) {
      persistPassword(storageKey, password);
    }
  }

  function initProtectedRoot(root) {
    const supported =
      typeof window !== "undefined" &&
      Boolean(window.crypto && window.crypto.subtle && window.TextEncoder && window.TextDecoder);
    const form = root.querySelector("[data-protected-form]");
    const input = root.querySelector("[data-protected-input]");
    const submit = root.querySelector("[data-protected-submit]");
    const storageKey = root.dataset.storageKey || storagePrefix + window.location.pathname;

    if (!supported || !(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
      setStatus(root, "Your browser does not support Web Crypto required for protected content.", "error");
      if (form instanceof HTMLElement) {
        form.hidden = true;
      }
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = input.value.trim();

      if (!password) {
        setStatus(root, "Enter a password first.", "error");
        input.focus();
        return;
      }

      if (submit instanceof HTMLButtonElement) {
        submit.disabled = true;
      }

      try {
        await unlock(root, password, true);
      } catch (_error) {
        clearStoredPassword(storageKey);
        setStatus(root, "Wrong password or corrupted payload.", "error");
      } finally {
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false;
        }
      }
    });

    const rememberedPassword = readStoredPassword(storageKey);
    if (!rememberedPassword) {
      return;
    }

    input.value = rememberedPassword;
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = true;
    }

    unlock(root, rememberedPassword, true)
      .catch(() => {
        clearStoredPassword(storageKey);
        input.value = "";
        setStatus(root, "Stored password is no longer valid. Enter it again.", "error");
      })
      .finally(() => {
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false;
        }
      });
  }

  for (const root of document.querySelectorAll("[data-protected-content-root]")) {
    if (root instanceof HTMLElement) {
      initProtectedRoot(root);
    }
  }
})();
