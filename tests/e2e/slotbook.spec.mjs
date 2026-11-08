import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Every browser test runs against the dedicated E2E server on port 3101.
// Neither production database schema nor user accounts are reset.
const HOST = 'demo-ny';
const GUEST_ZONE = 'Asia/Kolkata';

function dateInZone(zone, offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const base = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function jsonOk(response, label) {
  if (!response.ok()) {
    throw new Error(`${label} failed with HTTP ${response.status()}`);
  }
  return response.json();
}

async function findOpenDay(request, event, count = 2, isSuitable = () => true) {
  const meta = await jsonOk(await request.get(`/api/public/hosts/${HOST}`), 'Public host discovery');
  const matching = meta.events.find((item) => item.slug === event);
  expect(matching, `Demo event '${event}' must be active`).toBeTruthy();
  const horizon = Math.min(29, Number(matching.booking_horizon_days || 30));
  for (let i = 1; i <= horizon; i++) {
    const day = dateInZone(meta.host.time_zone, i);
    const result = await request.get(
      `/api/hosts/${HOST}/events/${event}/slots?from=${day}&to=${day}&tz=${encodeURIComponent(GUEST_ZONE)}`,
    );
    const body = await jsonOk(result, `${event} slots for ${day}`);
    const candidates = Array.isArray(body.slots) ? body.slots.filter(isSuitable) : [];
    if (candidates.length >= count) {
      return { day, slots: candidates, hostTimezone: meta.host.time_zone };
    }
  }
  throw new Error(`No future ${event} date has ${count} open slots. Check the demo host schedule or date overrides.`);
}

async function chooseGuestSlot(page, openDay, expectedSlot) {
  await page.goto(`/${HOST}/interview`);
  await expect(page.getByText(`Host schedule: ${openDay.hostTimezone}`, { exact: false })).toBeVisible();
  await page.getByLabel("Date (host's local calendar)").fill(openDay.day);
  await page.getByLabel('Display time zone').selectOption(GUEST_ZONE);
  const first = page.locator('.slot-grid button.slot').first();
  await expect(first).toContainText(expectedSlot.guest_local);
  await first.click();
  await expect(page.getByText('SELECTED TIME', { exact: true })).toBeVisible();
}

async function safeCancel(request, token, reason = 'Automated test cleanup') {
  if (!token) return;
  try {
    const lookup = await request.get(`/api/bookings/${encodeURIComponent(token)}`);
    if (!lookup.ok()) return;
    const booking = await lookup.json();
    if (!['held', 'confirmed'].includes(booking.status)) return;
    await request.post(`/api/bookings/${encodeURIComponent(token)}/cancel`, {
      data: { reason },
      headers: { 'Idempotency-Key': randomUUID() },
    });
  } catch {
    // Do not mask the original browser test error. A held seat expires after five minutes.
  }
}

test('01 — Host login/logout and responsive guest navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const menu = page.getByRole('button', { name: /Menu/ });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(nav.getByRole('link', { name: 'Browse hosts' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Manage booking' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Host dashboard' })).toBeVisible();

  await page.goto('/host');
  await expect(page.getByRole('heading', { name: 'Host sign in.' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(process.env.DEMO_EMAIL || 'demo@slotbook.local');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD || 'DemoPass!2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  for (const name of ['bookings', 'events', 'schedule', 'overrides', 'notifications', 'settings']) {
    await page.getByRole('navigation', { name: 'Host workspace tabs' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Host workspace tabs' }).getByRole('button', { name, exact: true })).toHaveClass(/active/);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Host sign in.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Host sign in.' })).toBeVisible();
});

test('02 — Guest can hold a seat, release it and choose again', async ({ page, request }) => {
  const openDay = await findOpenDay(request, 'interview', 2);
  await chooseGuestSlot(page, openDay, openDay.slots[0]);
  await page.getByRole('button', { name: 'Hold this time for five minutes' }).click();
  await expect(page.getByText('TEMPORARY HOLD', { exact: true })).toBeVisible();
  await expect(page.locator('.countdown')).toContainText('remaining');
  await page.getByRole('button', { name: 'Release hold / choose another time' }).click();
  await expect(page.getByText('Choose an available appointment to get started.')).toBeVisible();
  const after = await jsonOk(await request.get(
    `/api/hosts/${HOST}/events/interview/slots?from=${openDay.day}&to=${openDay.day}&tz=${encodeURIComponent(GUEST_ZONE)}`,
  ), 'Slots after releasing hold');
  expect(after.slots.some((s) => s.start_at === openDay.slots[0].start_at)).toBe(true);
});

test('03 — Guest confirms, privately manages, reschedules, cancels; host sees outbox', async ({ page, browser, request }) => {
  const openDay = await findOpenDay(request, 'interview', 3);
  const runId = randomUUID().slice(0, 8);
  const guestName = `Browser UAT ${runId}`;
  const guestEmail = `browser-uat-${runId}@example.test`;
  const cancelReason = `Browser UAT finished ${runId}`;
  let token = '';
  let privateContext;
  try {
    await chooseGuestSlot(page, openDay, openDay.slots[0]);
    await page.getByRole('button', { name: 'Hold this time for five minutes' }).click();
    await expect(page.getByText('TEMPORARY HOLD', { exact: true })).toBeVisible();
    await page.getByLabel('Full name').fill(guestName);
    await page.getByLabel('Email address').fill(guestEmail);
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Appointment confirmed' })).toBeVisible();

    const managePath = await page.getByRole('link', { name: /Manage appointment/ }).getAttribute('href');
    expect(managePath).toMatch(/^\/manage\/[^/]+$/);
    token = decodeURIComponent(managePath.split('/').at(-1));
    const before = await jsonOk(await request.get(`/api/bookings/${encodeURIComponent(token)}`), 'Confirmed booking');
    expect(before.status).toBe('confirmed');
    expect(before.guest_email).toBe(guestEmail);
    expect(before.start_at).toBe(openDay.slots[0].start_at);

    // Use a fresh browser context to prove the private link does NOT require host login.
    privateContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const managePage = await privateContext.newPage();
    await managePage.goto(managePath);
    await expect(managePage.locator('.status-label')).toHaveText('CONFIRMED');
    await expect(managePage.getByText(guestName, { exact: false })).toBeVisible();

    const nextSlots = await jsonOk(await request.get(
      `/api/hosts/${HOST}/events/interview/slots?from=${openDay.day}&to=${openDay.day}&tz=${encodeURIComponent(GUEST_ZONE)}`,
    ), 'Reschedule availability');
    const newSlot = nextSlots.slots.find((slot) => slot.start_at !== before.start_at);
    expect(newSlot).toBeTruthy();
    await managePage.getByLabel("Date (host's local calendar)").fill(openDay.day);
    await managePage.getByLabel('Display time zone').selectOption(GUEST_ZONE);
    const target = managePage.locator('.slot-grid button.slot').filter({ hasText: newSlot.guest_local }).first();
    await expect(target).toBeVisible();
    await target.click();
    await managePage.getByRole('button', { name: 'Move booking to selected time' }).click();
    await expect.poll(async () => {
      const result = await request.get(`/api/bookings/${encodeURIComponent(token)}`);
      return (await jsonOk(result, 'Rescheduled booking')).start_at;
    }).toBe(newSlot.start_at);
    const moved = await jsonOk(await request.get(`/api/bookings/${encodeURIComponent(token)}`), 'Moved booking');
    expect(moved.id).toBe(before.id);
    expect(moved.version).toBe(before.version + 1);
    expect(moved.status).toBe('confirmed');

    await managePage.getByRole('button', { name: 'Cancel appointment' }).click();
    const dialog = managePage.getByRole('dialog', { name: 'Cancel this appointment?' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill(cancelReason);
    await dialog.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(managePage.locator('.status-label')).toHaveText('CANCELLED');
    const cancelled = await jsonOk(await request.get(`/api/bookings/${encodeURIComponent(token)}`), 'Cancelled booking');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.id).toBe(before.id);
    const reopened = await jsonOk(await request.get(
      `/api/hosts/${HOST}/events/interview/slots?from=${openDay.day}&to=${openDay.day}&tz=${encodeURIComponent(GUEST_ZONE)}`,
    ), 'Availability after cancellation');
    expect(reopened.slots.some((slot) => slot.start_at === moved.start_at)).toBe(true);

    // Verify the host dashboard and its notification outbox using a normal login.
    const hostPage = await privateContext.newPage();
    await hostPage.goto('/host');
    await expect(hostPage.getByRole('heading', { name: 'Host sign in.' })).toBeVisible();
    await hostPage.getByLabel('Email', { exact: true }).fill(process.env.DEMO_EMAIL || 'demo@slotbook.local');
    await hostPage.getByLabel('Password').fill(process.env.DEMO_PASSWORD || 'DemoPass!2026');
    await hostPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(hostPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
    const upcoming = await jsonOk(await hostPage.request.get('/api/host/bookings'), 'Host active bookings');
    expect(upcoming.some((b) => b.id === before.id)).toBe(false);
    await hostPage.getByRole('navigation', { name: 'Host workspace tabs' }).getByRole('button', { name: 'notifications' }).click();
    await expect(hostPage.getByRole('heading', { name: 'Notification outbox' })).toBeVisible();
    const notifications = await jsonOk(await hostPage.request.get('/api/notifications'), 'Host notifications');
    expect(notifications.some((n) => n.event_type === 'confirmed' && n.payload?.guest_email === guestEmail)).toBe(true);
    expect(notifications.some((n) => n.event_type === 'rescheduled' && n.payload?.to === moved.start_at)).toBe(true);
    expect(notifications.some((n) => n.event_type === 'cancelled' && n.payload?.reason === cancelReason)).toBe(true);
  } finally {
    await safeCancel(request, token);
    if (privateContext) await privateContext.close();
  }
});

test('04 — Group event: exactly four of five simultaneous holds succeed', async ({ request }) => {
  const openDay = await findOpenDay(request, 'workshop', 1,
    (s) => s.capacity === 4 && s.remaining_seats === 4);
  const slot = openDay.slots[0];
  const created = [];
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => request.post('/api/holds', {
      data: { event_id: slot.event_id, start_at: slot.start_at },
      headers: { 'Idempotency-Key': randomUUID() },
    })));
    const statuses = responses.map((r) => r.status());
    for (const response of responses) {
      if (response.status() === 201) created.push(await response.json());
    }
    expect(statuses.filter((s) => s === 201).length).toBe(4);
    expect(statuses.filter((s) => s === 409).length).toBe(1);
    const slots = await jsonOk(await request.get(
      `/api/hosts/${HOST}/events/workshop/slots?from=${openDay.day}&to=${openDay.day}&tz=${encodeURIComponent(GUEST_ZONE)}`,
    ), 'Group capacity');
    expect(slots.slots.some((s) => s.start_at === slot.start_at && s.remaining_seats > 0)).toBe(false);
  } finally {
    await Promise.all(created.map((booking) => safeCancel(request, booking.hold_token)));
  }
});
