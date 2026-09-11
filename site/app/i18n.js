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
  // D-52: a day is three challenges, so the result talks about the day.
  dayDone: "{points} de {max} pontos hoje.",
  dayPerfect: "Dia perfeito! {points} de {max} pontos.",
  kindName: { shape: "silhueta", flag: "bandeira", capital: "capital", gdp: "PIB per capita" },
  answerWas: "Era {answer}.",
  // D-55: a challenge ends on its own screen, dismissed by hand. The old flow
  // swapped the next prompt in on the same frame and nobody saw the answer.
  revealSolved: "Acertou! +{points} pontos.",
  revealFailed: "Era {answer}.",
  continueChallenge: "Próximo desafio",
  seeResult: "Ver o resultado",
  // FR-6.9 / D-56 — "?" explains the hints of the challenge on screen. Two
  // texts, because the four kinds have two hint vocabularies between them.
  // Neither names a real country's figure: a static string that did would be
  // the answer to that country's `gdp` challenge (SEC-1).
  help: {
    title: "Como ler as pistas",
    close: "Fechar",
    country:
      "A resposta é um país.\n\n" +
      "A cada chute errado você ganha três pistas:\n\n" +
      "↔  a DISTÂNCIA em quilômetros entre o país que você chutou e a resposta.\n\n" +
      "↗  a SETA, apontando a direção da resposta a partir do seu chute: ↑ norte, → leste, ↓ sul, ← oeste e as diagonais.\n\n" +
      "%  a PROXIMIDADE: 100% é a própria resposta, 0% é o outro lado do mundo (20.000 km). É a mesma distância dita de outro jeito, e é ela que pinta a barra colorida à esquerda de cada chute.",
    gdp:
      "Aqui é ao contrário: o país está na pergunta e a resposta é um NÚMERO — o PIB per capita, em dólares.\n\n" +
      "Você não precisa acertar na mosca: vale se o seu chute e a resposta estiverem a 10% um do outro. Para uma resposta de 21.500, chutar 20.000 acerta; chutar 19.000 não.\n\n" +
      "A cada chute errado você ganha duas pistas:\n\n" +
      "↕  a SETA: ↑ quer dizer que a resposta é MAIOR que o seu chute, ↓ que é MENOR.\n\n" +
      "%  a PROXIMIDADE: o menor dos dois números dividido pelo maior. 50% quer dizer que você errou pelo dobro ou pela metade.\n\n" +
      "O valor é o PPP (paridade de poder de compra) do Banco Mundial, não o nominal que costuma aparecer primeiro numa busca — os dois são bem diferentes para quase todo país.",
  },
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
  // groups (FR-4)
  // "1 jogador" / "2 jogadores": a "|" splits singular from plural and `n` picks.
  players: "{n} jogador|{n} jogadores",
  owner: "dono",
  invited: "Você entrou em {name}.",
  inviteCreated: "Link criado. Vale por 7 dias e só funciona uma vez.",
  inviteRevoked: "Convite revogado.",
  renamed: "Grupo renomeado.",
  left: "Você saiu do grupo.",
  removed: "Jogador removido.",
  created: "Grupo criado.",
  copied: "Copiado!",
  copyFailed: "Não deu para copiar; selecione o link e copie.",
  noGroups: "Você ainda não está em nenhum grupo. Peça um convite a quem organiza.",
  notOrganizer: "Só organizadores criam grupos. Peça ao Paulo.",
  confirmJoin: "Você recebeu um convite para um grupo. Entrar?",
  confirmLeave: "Sair de {name}? Seus resultados ficam, mas você some do ranking.",
  // FR-4.9 / D-23: the last member out dissolves the group. Say so before it
  // happens — the old text only mentioned the ranking, and the group vanishing
  // with every invite link in it came as a surprise.
  confirmLeaveLast: "Você é o último membro de {name}. Sair APAGA o grupo, seus torneios e todos os links de convite que você já enviou. Isso não pode ser desfeito.",
  confirmRemove: "Remover {name} do grupo?",
  confirmRetry: "Dar uma nova chance a {name} hoje? A tentativa atual fica guardada no histórico.",
  playFirst: "Jogue primeiro para ver os resultados de hoje.",
  todayScore: "{points} pts · {n} chutes",
  closedThrough: "Ranking fechado até {day}. Hoje entra amanhã ao meio-dia.",
  noPending: "Nenhum convite pendente.",
  expires: "vale até {date}",
  // admin (FR-7.2)
  adminOnly: "Só o administrador vê esta página.",
  roleSaved: "Papel atualizado.",
  retryGranted: "Nova chance concedida.",
  loadMore: "Carregar mais",
  state: { not_started: "não jogou", in_progress: "jogando", finished: "terminou" },
  role: { admin: "admin", organizer: "organizador", player: "jogador" },
  // tournaments (FR-5 as rewritten, FR-8)
  tournaments: "Torneios",
  noTournaments: "Nenhum torneio por aqui ainda.",
  tournamentCreated: "Torneio criado. Chame o pessoal e comece quando quiser.",
  presetLabel: "Formato",
  join: "Entrar",
  leaveTournament: "Sair do torneio",
  joined: "Você entrou no torneio.",
  droppedOut: "Você saiu do torneio.",
  start: "Começar",
  started: "Torneio começado. Boa sorte.",
  closeRound: "Fechar rodada agora",
  roundClosed: "Rodada fechada.",
  tournamentOver: "Torneio encerrado.",
  cancelTournament: "Cancelar torneio",
  tournamentCancelled: "Torneio cancelado.",
  confirmStart: "Começar {name} com {n} jogadores? Depois disso ninguém mais entra.",
  confirmCloseRound: "Fechar a rodada agora? Quem não terminou fica com zero.",
  confirmCancelTournament: "Cancelar {name}? Não dá para voltar atrás.",
  confirmLeaveTournament: "Sair de {name}?",
  playCard: "Jogar a rodada",
  continueCard: "Continuar a rodada",
  cardDone: "Rodada terminada: {points} pontos.",
  roundOf: "Rodada {n} de {max}",
  challengeOf: "Desafio {n} de {max}",
  closesAt: "Fecha {when}.",
  waitingForOthers: "Resultados aparecem quando a rodada fechar.",
  capitalPrompt: "A capital é {city}.",
  // D-53: the country is the question here, and the figure is the answer.
  // The country leads, so the sentence needs no article — "de Vietnã" and
  // "de Itália" are both wrong, and 186 countries is too many to inflect.
  // D-54: the figure was always in dollars — only regras.html said so, and
  // nobody reads the rules before the first question. Players read the bare
  // number as reais and guessed five times high.
  gdpPrompt: "{country} — qual o PIB per capita em {year}, em dólares (PPP)?",
  needNumber: "Digite um número.",
  higher: "é mais",
  lower: "é menos",
  standingsPending: "A classificação aparece quando a primeira rodada fechar.",
  // Table headers. A free-for-all's points DECIDE the table; a league's only
  // break a tie, so they are labelled "Cartas" there and never "Pontos" (D-49).
  colName: "Nome",
  colMatchPoints: "Pts",
  colRecord: "V-E-D",
  colPoints: "Pontos",
  colCards: "Cartas",
  colRounds: "Rodadas",
  colGuesses: "Chutes",
  colTime: "Tempo",
  roundOpen: "em aberto",
  drawn: "empate",
  // Double elimination has two brackets running at once, so a fixture has to
  // say which one it belongs to or the list is unreadable.
  bracketOf: { w: "chave de cima", l: "chave de baixo", gf: "grande final" },
  colPhase: "Fase",
  // Knockout: how far each player got, and what a tiebreak is doing.
  phaseChampion: "campeão",
  phaseAlive: "na chave",
  phaseOut: "caiu na {n}ª",
  phaseOutFirst: "caiu na 1ª",
  suddenDeath: "Desempate {k}",
  suddenDeathMine: "Empate. Mais um desafio para decidir — só entre vocês.",
  suddenDeathTheirs: "Empate entre {names}. A chave espera o desempate.",
  byeCount: "{n} folga|{n} folgas",
  byeFixture: "{name} folga",
  statusOf: { draft: "montando", running: "em andamento", finished: "encerrado", cancelled: "cancelado" },
  itemState: { solved: "acertou", failed: "errou", current: "agora", pending: "a seguir" },
  drafting: "{n} inscritos. O organizador começa quando quiser.",
  notPlaying: "Você não está neste torneio.",
  // account (FR-1.5)
  deleted: "Conta apagada.",
  compass: { N: "norte", NE: "nordeste", E: "leste", SE: "sudeste", S: "sul", SW: "sudoeste", W: "oeste", NW: "noroeste" },
  errors: {
    "unauthenticated": "Entre para jogar.",
    "invalid-argument": "Pedido inválido. Recarregue a página.",
    "not-found": "Não há país agendado para hoje. Avisa o Paulo.",
    "already-completed": "Você já terminou o de hoje.",
    "no-guesses-remaining": "Acabaram as tentativas.",
    "rate-limited": "Calma! Espera um instante e tenta de novo.",
    "puzzle-not-open": "Esse dia não está aberto.",
    "not-invited": "Você precisa de um convite para jogar. Peça o link a quem te chamou.",
    "permission-denied": "Você não tem permissão para isso.",
    "too-many-groups": "Você já está em 10 grupos, o máximo.",
    "invalid-invite": "Esse convite não existe, já foi usado, foi revogado ou venceu.",
    "group-full": "Esse grupo está cheio.",
    "tournament-not-open": "Este torneio não tem rodada aberta agora.",
    "not-a-participant": "Você não está neste torneio.",
    "unavailable": "Sem conexão com o servidor. Sua tentativa não foi gasta; tente de novo.",
    "internal": "Deu ruim no servidor. Sua tentativa não foi gasta; tente de novo.",
    "default": "Algo deu errado ({code}). Sua tentativa não foi gasta; tente de novo.",
  },
};

const strings = PT_BR;

export function t(key, vars = {}) {
  const s = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), strings);
  if (typeof s !== "string") return key;
  // A "singular|plural" string picks by `n`. Portuguese only needs the two.
  const forms = s.split("|");
  const picked = forms.length > 1 && Number(vars.n) === 1 ? forms[0] : forms[forms.length - 1];
  return picked.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

/** Human message for a callable error: typed Mondo code first, then the SDK's own code. */
export function errorMessage(err) {
  const code = err?.details?.code ?? String(err?.code ?? "").replace(/^functions\//, "");
  return strings.errors[code] ?? t("errors.default", { code: code || "?" });
}
