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
  kindName: { shape: "silhueta", flag: "bandeira", capital: "capital", gdp: "PIB per capita", flagPick: "qual bandeira", shapePick: "qual silhueta", person: "quem nasceu onde" },
  // FR-9.9 — the five continents practice can be narrowed to. The server's own
  // ids are English (`world-countries`' `region`); these are the labels. América
  // is one continent here, as it is in a Brazilian classroom.
  continentName: { Africa: "África", Americas: "América", Asia: "Ásia", Europe: "Europa", Oceania: "Oceania" },
  answerWas: "Era {answer}.",
  // D-55: a challenge ends on its own screen, dismissed by hand. The old flow
  // swapped the next prompt in on the same frame and nobody saw the answer.
  revealSolved: "Acertou! +{points} pontos.",
  revealFailed: "Era {answer}.",
  // FR-8.7: the grid below is showing which one it was, so the line does not
  // repeat the country the prompt already named.
  revealPick: "Era esta.",
  // D-78 — the city, beside the country, on both the right answer and the wrong
  // one. "Era Rússia" alone teaches a player that the game is strange; "nasceu
  // em Kaliningrado" teaches them where Königsberg went.
  revealBorn: "Nasceu em {city}.",
  // D-81 — the bio under a finished `person` challenge. The credit is the
  // licence the paragraph is shown under, not a flourish.
  revealWiki: "Ler na Wikipédia",
  revealWikiCredit: "Wikipédia · CC BY-SA 4.0",
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
      "↗  a SETA, apontando onde a resposta está NO MAPA a partir do seu chute: ↑ norte, → leste, ↓ sul, ← oeste e as diagonais. É a direção que você seguiria de régua no mapa — se a resposta está mais ao sul, a seta aponta para baixo, sempre.\n\n" +
      "%  a PROXIMIDADE: 100% é a própria resposta, 0% é o outro lado do mundo (20.000 km). É a mesma distância dita de outro jeito, e é ela que pinta a barra colorida à esquerda de cada chute.",
    gdp:
      "Aqui é ao contrário: o país está na pergunta e a resposta é um NÚMERO — o PIB per capita, em dólares.\n\n" +
      "Você não precisa acertar na mosca: vale se o seu chute e a resposta estiverem a 10% um do outro. Para uma resposta de 21.500, chutar 20.000 acerta; chutar 19.000 não.\n\n" +
      "A cada chute errado você ganha duas pistas:\n\n" +
      "↕  a SETA: ↑ quer dizer que a resposta é MAIOR que o seu chute, ↓ que é MENOR.\n\n" +
      "%  a PROXIMIDADE: o menor dos dois números dividido pelo maior. 50% quer dizer que você errou pelo dobro ou pela metade.\n\n" +
      "O valor é o PPP (paridade de poder de compra) do Banco Mundial, não o nominal que costuma aparecer primeiro numa busca — os dois são bem diferentes para quase todo país.",
    // FR-8.7 / D-64, D-65 — a third vocabulary, and the shortest: no hint per
    // guess. Saying so IS the explanation, because a player who spent the first
    // pick waiting for a distance would think the game was broken. The one
    // thing that IS a clue is how the board is built, and hiding that would
    // just reward whoever noticed first.
    //
    // One text for both pick kinds (D-72): everything it says is true of eight
    // silhouettes as well as of eight flags, and a fourth topic differing by
    // one noun would be a popup nobody needed.
    pick:
      "Aqui o país está na pergunta e a resposta é uma das oito opções — bandeiras num desafio, silhuetas no outro.\n\n" +
      "Não há pista a cada erro: ou é aquela, ou não é. A opção que você escolher errado sai do tabuleiro e você tem mais uma chance.\n\n" +
      "Mas o tabuleiro não é sorteado do mundo inteiro: QUATRO das outras sete são dos países mais próximos da resposta, e três vêm de qualquer lugar. Se você reconhecer uma vizinha, já sabe em que canto do mapa procurar.\n\n" +
      "São duas tentativas. A primeira vale 6 pontos e a segunda 2 — bem menos que nos outros desafios, porque escolher entre oito é bem mais fácil que escrever o nome de um país entre 196.\n\n" +
      "Quando o desafio acaba, as oito aparecem com o nome do país — não só a certa. A ideia é você sair daqui tendo aprendido oito, não uma.",
    // D-78. The second paragraph is the one that matters: it is the difference
    // between a trick question and a thing learned, and a player who meets
    // Kant before reading it will think the game is broken.
    person:
      "A pergunta é uma pessoa e a resposta é um país, com as mesmas pistas da silhueta: distância, seta e proximidade a cada erro.\n\n" +
      "A resposta é o país de HOJE. Kant nasceu em Königsberg, que hoje é Kaliningrado, na Rússia — então a resposta é Rússia, não Alemanha. Marie Curie nasceu em Varsóvia quando a Polônia não existia no mapa, e a resposta é Polônia. Quando o desafio acaba, a cidade aparece junto com o país.\n\n" +
      "São seis tentativas, como na silhueta — reconhecer a pessoa é só o começo, e daí em diante você acha o país com a distância e a seta.\n\n" +
      "As pessoas vêm do Pantheon (MIT) e as fotos da Wikimedia Commons, com o crédito de cada uma embaixo da foto.",
  },
  // FR-2.13 / D-61 — zero points, and the answer.
  confirmGiveUp: "Desistir deste desafio? Ele fica com 0 pontos e você vê a resposta.",
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
  // FR-4.12 — two kinds of link, and the message says which one you just made,
  // because the difference between them is who else can use it.
  inviteCreated: {
    single: "Link criado. Vale 7 dias e só funciona uma vez.",
    multi: "Link criado. Vale 2 dias e serve para várias pessoas.",
  },
  inviteMode: { single: "uso único", multi: "várias pessoas" },
  inviteUses: "{n} entrou por ele|{n} entraram por ele",
  inviteRevoked: "Convite revogado.",
  copy: "Copiar",
  revoke: "Revogar",
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
  // D-57 — the desktop panel beside the game. FR-4.11 withholds everyone's
  // score until you have finished your own day, so the panel says why rather
  // than looking broken. "Jogue primeiro" belongs on the board, not here: you
  // ARE playing.
  scoresWhenDone: "As pontuações aparecem quando você terminar o seu dia.",
  // The rail's "score" slot for the challenge you are on. It is not a number,
  // which is the point: nothing has been scored there yet.
  stepNow: "agora",
  // The chip in the bar. The current streak left the counters below when it
  // moved up there, so `statStreak` is no longer rendered anywhere.
  streakDays: "dia seguido|dias seguidos",
  statLongest: "Melhor sequência",
  statPlayed: "Dias jogados",
  statSolved: "Dias perfeitos",
  closedThrough: "Ranking fechado até {day}. Hoje entra amanhã ao meio-dia.",
  noPending: "Nenhum convite ativo.",
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
  // FR-8.7 — the country is the question here, as it is for gdp. What is being
  // asked for is which of the eight is its flag.
  flagPickPrompt: "Qual destas é a bandeira de {country}?",
  // D-72 — the same sentence with the other noun.
  shapePickPrompt: "Qual destas é a silhueta de {country}?",
  // D-78 — the person is the question and the country is the answer, so the
  // sentence names them and nothing else. No occupation, no century: both are
  // the answer in disguise for anyone who knows the period.
  personPrompt: "Onde nasceu {name}?",
  optionLabel: "opção {n}",
  optionStruck: "opção {n}, já descartada",
  optionRight: "opção {n}, a resposta certa",
  // Once the challenge is over the board names every option (D-76), and the
  // label says what the caption says: a screen reader gets the same lesson.
  optionNamed: "opção {n}: {country}",
  optionStruckNamed: "opção {n}, já descartada: {country}",
  optionRightNamed: "opção {n}, a resposta certa: {country}",
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
  // practice (FR-9). The whole point of the screen is that nothing on it is
  // shared, so the copy says so twice: once before you start and once in the
  // total. The per-kind lines describe the QUESTION and never the guess budget,
  // which belongs to the kind and would go stale here the day one changed.
  practice: {
    about: {
      shape: "Que país tem esta silhueta?",
      flag: "Que país tem esta bandeira?",
      capital: "Que país tem esta capital?",
      gdp: "Qual o PIB per capita deste país?",
      flagPick: "Qual destas oito é a bandeira do país?",
      shapePick: "Qual destas oito é a silhueta do país?",
      person: "Onde nasceu esta pessoa?",
    },
    counter: "Desafio {n} · {points} pts",
    // FR-9.9. The hint only appears once the chips and the running session
    // disagree — a rail that nags before you have touched it is noise.
    continents: "Continentes",
    continentsHint: "Toque em um tipo para recomeçar com estes continentes.",
    next: "Próximo desafio",
    confirmLeave: "Sair do treino? Você vai ver o total do que fez até agora.",
    done: "{points} de {max} pontos em {n} desafio, {solved}.|{points} de {max} pontos em {n} desafios, {solved}.",
    doneNone: "Você saiu antes de terminar um desafio. Nada para somar.",
    solvedCount: "{n} acerto|{n} acertos",
    // The desktop panel (FR-6.11). "Taxa de acerto" is desafios acertados sobre
    // desafios terminados — not points over the maximum, which is a different
    // number and would disagree with "Acertos" sitting directly above it.
    statPoints: "Pontos",
    statPlayed: "Desafios",
    statSolved: "Acertos",
    statRate: "Taxa de acerto",
  },
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
    "no-countries-left": "Nenhum país sobrou nesses continentes para esse tipo. Marque outro continente ou treine outro tipo.",
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
