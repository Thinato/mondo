// Perfil e "excluir conta" (FR-1.3, FR-1.5) — the two dialogs behind the avatar
// menu, on every page that now carries one.
//
// The markup is built here rather than repeated in five HTML files. It is
// chrome, not content: TEMPLATE is a frozen literal with nothing interpolated
// into it and nothing from the server anywhere near it, so the rule this file
// looks like it is breaking — never parse a string as markup — is not the rule
// that is at stake. The alternative was five copies of the same <dialog>
// drifting apart one page at a time.

import { signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth } from "./firebase.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

const TEMPLATE = `
<dialog id="profile-dialog">
  <form id="profile-form" method="dialog">
    <h2>Perfil</h2>
    <label for="profile-name">Nome de exibição</label>
    <input id="profile-name" type="text" minlength="3" maxlength="24" required
           pattern="[\\p{L}\\p{N} _\\-]{3,24}" autocomplete="nickname">
    <p class="fine">3 a 24 caracteres: letras, números, espaço, - ou _. É o que os outros veem.</p>
    <p id="profile-error" class="err" aria-live="polite"></p>
    <div class="actions">
      <button type="button" id="delete-btn" class="link">Excluir conta</button>
      <button type="submit" value="cancel" class="link">Cancelar</button>
      <button type="submit" value="save" class="primary">Salvar</button>
    </div>
  </form>
</dialog>
<dialog id="delete-dialog">
  <form id="delete-form" method="dialog">
    <h2>Excluir conta</h2>
    <p>Apaga na hora: seu login, seu perfil, todos os seus resultados e sua participação em todos os grupos. Não dá para desfazer.</p>
    <p id="delete-error" class="err" aria-live="polite"></p>
    <div class="actions">
      <button type="submit" value="cancel" class="link">Cancelar</button>
      <button type="submit" value="ok" class="primary">Excluir tudo</button>
    </div>
  </form>
</dialog>`;

/**
 * Wire the "Perfil" item of the account menu. Returns `setName`, which the page
 * calls once it knows the name the server has — on the daily that is `round.me`,
 * everywhere else it is whatever Google gave the session.
 */
export function mountProfile({ button, setStatus = () => {} }) {
  if (!button) return { setName() {} };

  const host = document.createElement("div");
  host.innerHTML = TEMPLATE;
  document.body.append(...host.children);

  const $ = (id) => document.getElementById(id);
  const dialog = $("profile-dialog"), form = $("profile-form"), field = $("profile-name"), error = $("profile-error");
  const deleteBtn = $("delete-btn"), deleteDialog = $("delete-dialog"), deleteForm = $("delete-form"), deleteError = $("delete-error");
  let name = "";

  button.addEventListener("click", () => {
    error.textContent = "";
    field.value = name;
    dialog.showModal();
    field.select();
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (ev.submitter?.value === "cancel") return dialog.close();
    try {
      const saved = await api.updateProfile({ displayName: field.value });
      name = saved.displayName;
      dialog.close();
      setStatus(t("saved"), "ok");
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  });

  // FR-1.5: delete everything, then sign out (which clears client state, FR-1.6).
  deleteBtn.addEventListener("click", () => {
    dialog.close();
    deleteError.textContent = "";
    deleteDialog.showModal();
  });
  deleteForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (ev.submitter?.value !== "ok") return deleteDialog.close();
    ev.submitter.disabled = true;
    try {
      await api.deleteAccount({});
      deleteDialog.close();
      await signOut(auth);
      setStatus(t("deleted"), "ok");
    } catch (err) {
      deleteError.textContent = errorMessage(err);
    } finally {
      ev.submitter.disabled = false;
    }
  });

  return { setName(n) { name = n ?? ""; } };
}
