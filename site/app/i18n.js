// UI strings. pt-BR only until the toggle ships (OQ-6, Phase 4); kept here from
// day one so nothing has to be untangled later. `t("key", { n: 3 })`.

const PT_BR = {
  title: "Mondo",
  tagline: "Que país é este?",
  signIn: "Entrar com Google",
  signOut: "Sair",
  loading: "Carregando…",
  openingLogin: "Abrindo o login do Google…",
  placeholder: "Digite um país…",
  guess: "Chutar",
  guessesLeft: "{n} de {max} tentativas",
  noMatch: "Nenhum país com esse nome. Tente o nome em português, em inglês ou a sigla.",
  pickOne: "Escolha um país da lista antes de chutar.",
  solved: "Acertou em {n}! {points} pontos.",
  solvedOne: "De primeira! {points} pontos.",
  failed: "Não foi hoje. Era {answer}.",
  answerWas: "Era {answer}.",
  share: "Compartilhar",
  copied: "Copiado!",
  nextPuzzle: "Novo país todo dia ao meio-dia.",
  rules: "Regras",
  privacy: "Privacidade",
  profile: "Perfil",
  displayName: "Nome de exibição",
  displayNameHint: "3 a 24 caracteres: letras, números, espaço, - ou _. É o que os outros veem.",
  save: "Salvar",
  cancel: "Cancelar",
  saved: "Nome atualizado.",
  compass: { N: "norte", NE: "nordeste", E: "leste", SE: "sudeste", S: "sul", SW: "sudoeste", W: "oeste", NW: "noroeste" },
  errors: {
    "unauthenticated": "Entre para jogar.",
    "invalid-argument": "Pedido inválido. Recarregue a página.",
    "not-found": "Não há país agendado para hoje. Avisa o Paulo.",
    "already-completed": "Você já terminou o de hoje.",
    "no-guesses-remaining": "Acabaram as tentativas.",
    "rate-limited": "Calma! Espera um instante e tenta de novo.",
    "puzzle-not-open": "Esse dia não está aberto.",
    "unavailable": "Sem conexão com o servidor. Sua tentativa não foi gasta; tente de novo.",
    "internal": "Deu ruim no servidor. Sua tentativa não foi gasta; tente de novo.",
    "default": "Algo deu errado ({code}). Sua tentativa não foi gasta; tente de novo.",
  },
};

const strings = PT_BR;

export function t(key, vars = {}) {
  const s = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), strings);
  if (typeof s !== "string") return key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

/** Human message for a callable error: typed Mondo code first, then the SDK's own code. */
export function errorMessage(err) {
  const code = err?.details?.code ?? String(err?.code ?? "").replace(/^functions\//, "");
  return strings.errors[code] ?? t("errors.default", { code: code || "?" });
}
