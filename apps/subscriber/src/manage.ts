const status = document.querySelector<HTMLElement>('#copy-status');

function announce(message: string): void {
  if (status !== null) status.textContent = message;
}

async function copyText(text: string, success: string): Promise<void> {
  try {
    if (navigator.clipboard === undefined) {
      throw new Error(
        'Clipboard is unavailable. Select and copy the link or diagnostics text manually.',
      );
    }
    await navigator.clipboard.writeText(text);
    announce(success);
  } catch (error) {
    announce(
      error instanceof Error ? error.message : 'Copy failed. Select and copy the text manually.',
    );
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy-link]')) {
  button.addEventListener('click', () => {
    const link = button.closest('.pairing-option')?.querySelector<HTMLAnchorElement>('a');
    if (link !== null && link !== undefined)
      void copyText(link.href, 'Pairing link copied. Keep it private.');
  });
}

document.querySelector('#copy-diagnostics')?.addEventListener('click', () => {
  const text = document.querySelector('#diagnostics-text')?.textContent;
  if (text !== null && text !== undefined)
    void copyText(text, 'Diagnostics copied. Review before sharing.');
});
