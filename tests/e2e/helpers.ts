import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/** Общие шаги сквозных тестов: свежий человек с подтверждённой почтой. */

export const MAILPIT = process.env.TEST_MAILPIT_URL || "http://mailpit:8025";

export function tag(): string {
  return "test-" + Math.random().toString(16).slice(2, 10);
}

/** Ссылка подтверждения из письма. Ходим в Mailpit, а не в базу: письмо —
 *  часть обещания продукта, и пусть оно проверяется вместе со всем прочим. */
export async function confirmLink(request: APIRequestContext, email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(email)}`);
    if (res.ok()) {
      const body = await res.json();
      const first = body.messages?.[0];
      if (first) {
        const full = await request.get(`${MAILPIT}/api/v1/message/${first.ID}`);
        const text = (await full.json()).Text || "";
        const match = text.match(/https?:\/\/\S*\/confirm\/[A-Za-z0-9_-]+/);
        if (match) return match[0];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Письмо для ${email} не пришло`);
}

export async function signIn(page: Page): Promise<string> {
  const login = tag();
  const email = `${login}@example.test`;
  const password = "Test-Passw0rd";

  const reg = await page.request.post("/api/auth/register", {
    data: { email, login, display_name: "Сквозной разметчик", password },
  });
  expect(reg.ok(), await reg.text()).toBeTruthy();

  const link = await confirmLink(page.request, email);
  await page.goto(new URL(link).pathname);

  // Подтверждение не входит в аккаунт (чужая ссылка не должна подменять
  // сессию), поэтому после него — обычный вход.
  await expect(page.getByText("Почта подтверждена")).toBeVisible({ timeout: 20_000 });
  const signed = await page.request.post("/api/auth/login", {
    data: { identity: login, password },
  });
  expect(signed.ok(), await signed.text()).toBeTruthy();
  const me = await page.request.get("/api/auth/me");
  expect(me.ok(), await me.text()).toBeTruthy();
  expect((await me.json()).user.login).toBe(login);
  return login;
}
