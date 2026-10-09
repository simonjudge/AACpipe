import type { SubscriberView } from './controller.js';

export function removePairingFragment(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'replaceState'>,
): string {
  const url = new URL(location.href);
  url.hash = '';
  history.replaceState(null, '', url.toString());
  return url.toString();
}

export function renderSubscriberView(element: HTMLElement, view: SubscriberView): void {
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.dataset['connectionState'] = view.status;
  element.textContent = view.text;
  element.toggleAttribute('data-speaking', view.state === 'SPEAKING');
  element.toggleAttribute('data-truncated', view.truncated);
}
