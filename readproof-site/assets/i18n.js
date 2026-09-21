/* ReadProof PL/EN switcher.
   EN lives inline in HTML (default). PL strings below swap in when selected.
   Choice persists in localStorage (rp-lang), defaults to browser language.
   Static content swaps on DOMContentLoaded; dynamic (API) strings use rpT(key, enFallback).
   Language toggle reloads the page so API-rendered blocks come out consistent. */
(function(){
  var PL = {
    /* nav */
    nav_students: "Uczniowie", nav_teachers: "Nauczyciele", nav_challenges: "Wyzwania",
    nav_publishers: "Wydawcy", nav_verify: "Weryfikuj", nav_home: "Strona główna", nav_start: "Zacznij",
    nav_demo: "Demo", nav_forteachers: "Dla nauczycieli",
    /* hero */
    eyebrow: "Czytanie · Rozumienie · Dowód",
    hero_a: "Przeczytaj prawdziwą książkę.",
    hero_b: "Udowodnij, że ją zrozumiałeś.",
    hero_sub: "ReadProof pomaga uczniom, czytelnikom i nauczycielom sprawdzać prawdziwe zrozumienie książek — a nie tylko to, czy ktoś mówi, że je przeczytał.",
    cta_students: "Dla uczniów", cta_teachers: "Dla nauczycieli", cta_explore: "Poznaj ReadProof",
    pl_books: "Prawdziwe książki, prawdziwe rozdziały",
    pl_challenges: "Wyzwania ze zrozumienia",
    pl_certs: "Weryfikowalne certyfikaty",
    how_title: "Jak to działa",
    st_choose: "Wybierz książkę", st_choose_p: "Wybierz prawdziwą książkę z katalogu albo zadanie od nauczyciela.",
    st_read: "Przeczytaj", st_read_p: "Przeczytaj fizyczną książkę. Aplikacja nigdy nie zastępuje czytania.",
    st_challenge: "Podejmij wyzwanie", st_challenge_p: "Odpowiedz na 5 pytań ze zrozumienia do każdego rozdziału.",
    st_proof: "Zdobądź dowód", st_proof_p: "Certyfikat ReadProof potwierdzający zrozumienie.",
    /* audience */
    who_k: "Dla kogo", who_h: "ReadProof dla każdego, kto czyta.",
    who_sub: "Jedna platforma, trzy sposoby korzystania. Łatwo powiedzieć, że się przeczytało. Trudniej udowodnić zrozumienie.",
    tag_students: "Dla uczniów", tag_readers: "Dla czytelników", tag_teachers: "Dla nauczycieli",
    s_h: "Ucz się z książek. Udowodnij, co umiesz.",
    s_1: "Praktyka z lektur i wyzwania z rozdziałów", s_2: "Przygotowanie do matury",
    s_3: "Przygotowanie do egzaminów i własny postęp", s_4: "Weryfikowalne certyfikaty ReadProof",
    r_h: "Czytaj. Rozumiej. Udowodnij.",
    r_1: "Wyzwania czytelnicze i testy zrozumienia", r_2: "Osobista historia czytania",
    r_3: "Dowód zrozumienia każdej książki", r_4: "Śledź postępy w całej bibliotece",
    t_h: "Sprawdź, kto naprawdę rozumie lekturę.",
    t_1: "Twórz klasy i zadawaj książki", t_2: "Śledź postępy i przeglądaj wyniki",
    t_3: "Wyłapuj uczniów, którzy potrzebują pomocy", t_4: "Generuj certyfikaty",
    /* how/example */
    ex_k: "W środku wyzwania",
    ex_h_a: "Łatwo powiedzieć, że się przeczytało.",
    ex_h_b: "Trudniej udowodnić zrozumienie.",
    ex_sub: "Każdy rozdział kończy się 5 krótkimi pytaniami o sens — bohaterowie, motywy, przyczyna i skutek. Nigdy o drobiazgi w stylu „jaki kolor miał zegarek”. Tak to wygląda:",
    ex_q_k: "Przykład · Alicja w Krainie Czarów, rozdz. 1",
    ex_q: "Dlaczego Alicja podąża za Białym Królikiem?",
    ex_a: "Z ciekawości — gadający królik w kamizelce to zbyt dziwne, by to zignorować",
    ex_b: "Chce ukraść mu zegarek kieszonkowy",
    ex_c: "Siostra każe jej za nim iść",
    ex_d: "Spóźnia się na herbatkę i liczy, że on zna drogę",
    ex_note: "Dobrze — a aplikacja wyjaśnia dlaczego, więc pomyłka staje się lekcją, nie tylko oceną.",
    f1_h: "Zrozumienie, nie pamięć", f1_p: "Pytania sprawdzają, czy zrozumiałeś historię — nie czy wykuteś detale.",
    f2_h: "5 pytań na rozdział", f2_p: "Różne typy: wybory, kto to powiedział, układanie kolejności, odpowiedzi otwarte oceniane za sens.",
    f3_h: "Zalicz i udowodnij", f3_p: "Twój wynik staje się weryfikowalnym certyfikatem — jeden link, do sprawdzenia przez każdego.",
    /* cert */
    cert_k: "Certyfikaty", cert_h: "Certyfikat potwierdzonego zrozumienia.",
    cert_sub: "Ukończ wyzwanie i odbierz Certyfikat ReadProof z wynikiem i weryfikowalnym ID dowodu. Każdy — nauczyciel, szkoła, pracodawca — sprawdzi go jednym linkiem.",
    cert_how: "Jak to działa", cert_verify: "Weryfikuj certyfikat",
    /* catalog */
    lib_k: "Biblioteka", lib_h: "Zacznij od klasyki.",
    lib_sub: "Książki z domeny publicznej z Project Gutenberg plus wyzwania czytelnicze od wydawców. Poniżej żywy katalog — serwowany przez API ReadProof.",
    /* schools */
    sch_k: "Dla szkół", sch_h: "Zamień zadania z lektur w mierzalne zrozumienie.",
    sch_sub: "Twórz klasy, zadawaj książki, oglądaj wyniki — w tym kto potrzebuje pomocy. Prosty panel, zero wdrożeń. Liczby poniżej pochodzą na żywo z sieci.",
    sch_teachers: "Dla nauczycieli", sch_demo: "Otwórz demo panelu",
    ps_books: "Książki w sieci", ps_challenges: "Aktywne wyzwania",
    ps_proofs: "Zapisane dowody", ps_verified: "Zweryfikowane",
    /* publishers */
    pub_k: "Dla wydawców", pub_h: "Twórz wyzwania czytelnicze wokół swoich książek.",
    pub_sub: "Wybierz książkę, utwórz wyzwanie, ufunduj pulę nagród. Czytelnicy biorą udział, ReadProof weryfikuje zrozumienie, nagrody trafiają według ustalonych zasad.",
    pub_panel: "Panel wydawcy", pub_all: "Wszystkie wyzwania",
    /* publishers page */
    pp_panel_cta: "Panel wydawcy", pp_eyebrow: "Dla wydawców",
    pp_h_a: "Zamień swoje książki w", pp_h_b: "wyzwania czytelnicze.",
    pp_sub: "Wybierz książkę, utwórz wyzwanie, ufunduj pulę nagród. Czytelnicy biorą udział, ReadProof weryfikuje zrozumienie, nagrody trafiają według ustalonych zasad.",
    pp_open: "Otwórz panel wydawcy", pp_how: "Jak to działa",
    pp_reward_k: "Pula nagród", pp_reward_h: "Promocja napędzana przez ludzi, którzy naprawdę skończyli książkę.",
    pp_reward_p: "Fundujesz stałą pulę na wyzwanie. Kwalifikują się tylko zweryfikowane dowody — bez botów i przekartkowanych stron.",
    pp_flow_k: "Twoja ścieżka", pp_flow_h: "Od manuskryptu do mierzalnych czytelników.",
    pp_f1: "Wybierz książkę", pp_f1p: "Twój tytuł albo klasyk z domeny publicznej — z ISBN i okładką.",
    pp_f2: "Utwórz Wyzwanie Czytelnicze", pp_f2p: "Nazwa, opis, daty, limit uczestników, zasady kwalifikacji i nagród.",
    pp_f3: "Ufunduj pulę nagród", pp_f3p: "Stała kwota na wyzwanie. Szczegóły w panelu — rozliczenie na Solana Devnet w trybie demo.",
    pp_f4: "Czytelnicy biorą udział", pp_f4p: "Czytają prawdziwą książkę i kończą wyzwania z rozdziałów.",
    pp_f5: "ReadProof weryfikuje zrozumienie", pp_f5p: "Odpowiedzi sprawdzane co do sensu, antycheat na urządzeniu. Kwalifikują się tylko zweryfikowane dowody.",
    pp_f6: "Nagrody są wypłacane", pp_f6p: "Automatycznie, według opublikowanych przez Ciebie zasad.",
    pp_live_k: "Wyzwania na żywo", pp_live_h: "Dzieje się w sieci właśnie teraz.",
    pp_all: "Wszystkie wyzwania",
    pp_c1: "Prawdziwe dane o udziale", pp_c1p: "Uczestnicy, ukończenia, średni wynik — na wyzwanie, na żywo z API.",
    pp_c2: "Weryfikowalne z natury", pp_c2p: "Każda nagroda ma odpowiadać ID dowodu, które każdy sprawdzi.",
    pp_c3: "Treść książki zostaje prywatna", pp_c3p: "Pełny tekst żyje na serwerze do generowania pytań. On-chain trafia tylko hash dowodu.",
    pp_ready: "Gotowy, by rzucić wyzwanie czytelnikom?", pp_ready_sub: "Trzy kroki w panelu: rejestracja (szkic) → wgraj treść → ufunduj pulę.",
    pp_open2: "Otwórz panel wydawcy →",
    camps_k: "Wyzwania na żywo", camps_h: "Wyzwania czytelnicze",
    /* tech */
    tech_k: "Pod maską", tech_h: "Dowód, któremu ufasz. Infrastruktura, której nie zauważasz.",
    tech_sub: "Każdy zweryfikowany wynik zapisywany jest jako odporny na manipulacje dowód. Ty czytasz, podejmujesz wyzwania i zdobywasz certyfikaty — weryfikacja po prostu działa w tle.",
    tech_1: "Wyzwanie ukończone i zrozumienie zweryfikowane",
    tech_2: "Dowód zapisany — do sprawdzenia po ID w",
    tech_3: "Szczegóły dowodu",
    tech_note: "Środowisko demo: sieć testowa, bez prawdziwych środków. Teksty książek i odpowiedzi nigdy nie trafiają on-chain — tylko hash dowodu.",
    /* app */
    app_k: "Aplikacja iOS", app_h: "Zabierz ReadProof wszędzie.",
    app_sub: "Natywna aplikacja iOS z rolami dla uczniów, czytelników i nauczycieli. Wybierz rolę raz — cały interfejs się dostosuje.",
    app_role: "Wybierz swoją rolę",
    /* footer */
    foot_tag: "Przeczytaj prawdziwą książkę. Udowodnij, że ją zrozumiałeś.",
    foot_about: "O autorze",
    /* students page */
    sp_eyebrow: "Dla uczniów",
    sp_h_a: "Zamień czytanie w coś,",
    sp_h_b: "co da się udowodnić.",
    sp_sub: "Ucz się z książek. Ćwicz rozdział po rozdziale. Udowodnij, co umiesz — certyfikatem z wynikiem, do sprawdzenia przez każdego.",
    sp_how: "Jak to działa", sp_matura: "Przygotowanie do matury",
    flow_h: "Twoja ścieżka",
    flow_sub: "Wybierz książkę. Przeczytaj. Udowodnij.",
    fl_1: "Wybierz książkę", fl_1p: "Wybierz z katalogu, wyzwania czytelniczego albo zadania od nauczyciela.",
    fl_2: "Przeczytaj", fl_2p: "Przeczytaj prawdziwą, fizyczną książkę — rozdział po rozdziale, we własnym tempie.",
    fl_3: "Podejmij wyzwanie", fl_3p: "Odpowiedz na 5 pytań ze zrozumienia do każdego rozdziału: bohaterowie, motywy, przyczyna i skutek.",
    fl_4: "Zobacz wynik", fl_4p: "Wynik od razu, z wyjaśnieniami do wszystkiego, co poszło nie tak.",
    fl_5: "Zdobądź Certyfikat ReadProof", fl_5p: "Certyfikat potwierdzonego zrozumienia z weryfikowalnym ID dowodu.",
    mat_k: "Egzaminy", mat_h: "Przygotowanie do matury i praktyka z lektur.",
    mat_p: "Używaj ReadProof do przygotowania do matury i praktyki z lektur: przerabiaj lektury, testuj zrozumienie i zbieraj Certyfikaty ReadProof jako ślad postępów. Certyfikaty ReadProof dokumentują wykazane zrozumienie — nie są urzędowymi świadectwami egzaminacyjnymi.",
    sc_h: "Twój dowód w jednym linku.",
    sc_sub: "Każde zaliczone wyzwanie to certyfikat: książka, Twoje imię, wynik i unikalne ID. Udostępnij link — nauczyciele i szkoły zweryfikują go natychmiast.",
    sc_verify: "Weryfikuj certyfikat",
    sc_ready: "Gotów udowodnić pierwszą książkę?",
    sc_ready_sub: "Zacznij od klasyki, dołącz do wyzwania albo poproś nauczyciela o zadanie.",
    sc_browse: "Przeglądaj wyzwania", sc_imteacher: "Jestem nauczycielem",
    /* teachers page */
    tp_eyebrow: "Dla nauczycieli",
    tp_h_a: "Zamień zadania z lektur",
    tp_h_b: "w mierzalne zrozumienie.",
    tp_sub: "Sprawdź, kto naprawdę rozumie lekturę. Zadawaj książki, śledź postępy i wyłapuj uczniów, którzy potrzebują pomocy — przed egzaminem.",
    tp_demo: "Otwórz demo panelu", tp_how: "Jak to działa",
    tf_h: "Twoja ścieżka",
    tf_sub: "Pięć kroków do klasy, która czyta.",
    tf_1: "Utwórz klasę", tf_1p: "Dodaj uczniów raz — np. klasa 2A, 28 uczniów.",
    tf_2: "Zadaj książkę", tf_2p: "Wybierz tytuł i ustaw termin wyzwania.",
    tf_3: "Uczniowie kończą wyzwania", tf_3p: "Czytają prawdziwą książkę i udowadniają zrozumienie rozdział po rozdziale.",
    tf_4: "Zobacz wyniki", tf_4p: "Procent realizacji, średni wynik, rezultaty uczniów i certyfikaty.",
    tf_5: "Wskaż, kto potrzebuje pomocy", tf_5p: "Skup lekcje tam, gdzie zrozumienie jest najsłabsze.",
    dp_h: "Proste z zasady.",
    dp_k: "Podgląd panelu",
    dp_sub: "Bez szkoleń. Panel odpowiada na trzy pytania: kto skończył, jak poszło, kto potrzebuje uwagi. Liczby na żywo z sieci — pełny widok nauczyciela zobaczysz w interaktywnym demo.",
    dp_what: "Co widzi klasa",
    dp_what_h: "Procent realizacji, średni wynik, wyniki uczniów.",
    dp_what_p: "Zadaj książkę z terminem. Gdy uczniowie weryfikują zrozumienie, panel wypełnia się sam: kto skończył, kto jest w tyle, na co przeznaczyć następną lekcję.",
    dp_open: "Zobacz demo panelu",
    tc_1: "Zadawaj książki", tc_1p: "Cały kanon albo pojedynczy rozdział. Z terminami.",
    tc_2: "Śledź postępy", tc_2p: "Procent realizacji i średni wynik na klasę i ucznia.",
    tc_4: "Generuj certyfikaty", tc_4p: "Wystawiaj Certyfikaty ReadProof potwierdzające zrozumienie.",
    /* challenge page */
    ch_k: "Na żywo z sieci",
    ch_h: "Wyzwania czytelnicze.",
    ch_sub: "Wydawcy tworzą wyzwania wokół książek i fundują pule nagród. Czytelnicy biorą udział, ReadProof weryfikuje zrozumienie, nagrody trafiają według ustalonych zasad. Wszystko poniżej to żywe dane z sieci.",
    ch_how: "Jak działają nagrody",
    ch_s1: "Wydawca wybiera książkę", ch_s1p: "…i tworzy Wyzwanie Czytelnicze.",
    ch_s2: "Pula nagród jest fundowana", ch_s2p: "Stała kwota, zablokowana ustalonymi zasadami.",
    ch_s3: "Czytelnicy biorą udział", ch_s3p: "Czytają książkę, kończą wyzwania z rozdziałów.",
    ch_s4: "ReadProof weryfikuje zrozumienie", ch_s4p: "Kwalifikują się tylko zweryfikowane dowody.",
    ch_s5: "Nagrody są rozdzielane", ch_s5p: "Automatycznie, według opublikowanych zasad.",
    ch_want: "Chcesz wyzwanie do swojej książki?",
    ch_want_sub: "Wydawcy tworzą i fundują wyzwania w panelu wydawcy.",
    ch_back: "Wróć na stronę główną",
    ch_none: "Brak wyzwań w sieci — bądź pierwszym wydawcą w panelu wydawcy.",
    ch_part: "Uczestnicy", ch_ver: "Zweryfikowane", ch_pool: "Pula nagród",
    ch_avg: "Śr. wynik", ch_details: "Szczegóły i nagrody",
    /* verify page */
    v_k: "Weryfikacja", v_h: "Zweryfikuj certyfikat.",
    v_sub: "Wpisz ID certyfikatu (np. RP-7K2Q) albo otwórz link udostępniony do certyfikatu.",
    v_label: "ID certyfikatu", v_btn: "Weryfikuj",
    /* teacher demo */
    td_k: "Panel nauczyciela",
    td_hi: "Dzień dobry.",
    td_c1: "Twoje klasy", td_c2: "Aktywne zadania", td_c3: "Uczniowie", td_c4: "Śr. realizacja",
    td_t1: "Przegląd", td_t2: "Klasy", td_t3: "Zadania", td_t4: "Uczniowie", td_t5: "Certyfikaty",
    td_up: "Nadchodzące terminy",
    /* shared dynamic */
    live: "na żywo", offline: "offline", connecting: "łączenie…",
    net_live: "Sieć: na żywo",
    net_offline: "Sieć: offline — pokazuję zapisane informacje",
    camps_count: "{n} wyzwań czytelniczych na żywo",
    lp_first: "Brak zweryfikowanych dowodów w sieci — Twój może być pierwszy.",
    lp_offline: "Sieć offline — certyfikaty ładują się na żywo, gdy API jest osiągalne.",
    lp_line: "Wykazane zrozumienie · Wynik:",
    lp_verified: "Zweryfikowany dowód",
    vf_checking: "Sprawdzanie…",
    vf_notfound: "Nie znaleziono certyfikatu",
    vf_noid_a: "Brak certyfikatu o ID",
    vf_noid_b: "w rekordach na żywo i zestawie demo. Sprawdź ID albo wypróbuj demo:",
    vf_details: "Szczegóły dowodu",
    vf_proofrec: "Dowód zapisany",
    vf_net: "Sieć: Solana Devnet",
    vf_proofid: "ID dowodu:",
    vf_tx: "Transakcja:",
    vf_devnet: "rekord devnet",
    vf_demo: "DEMO · przykład poglądowy",
    no_camps: "Brak wyzwań na żywo — wydawcy tworzą je w panelu wydawcy.",
    no_proofs: "Brak zweryfikowanych dowodów w sieci — ukończ wyzwanie w aplikacji, a Twój dowód pojawi się tutaj.",
    check_proof: "Sprawdź ten dowód", all_ch: "wyzwań czytelniczych na żywo",
    cat_offline: "Katalog chwilowo offline — aplikacja działa na wbudowanych książkach. Klasyka: Alicja w Krainie Czarów, Sherlock Holmes, Wyspa Skarbów, Tomek Sawyer, W 80 dni dookoła świata."
  };
  var KEY = "rp-lang";
  function current(){
    try{ return localStorage.getItem(KEY) || ((navigator.language || "en").toLowerCase().indexOf("pl") === 0 ? "pl" : "en"); }
    catch(e){ return "en"; }
  }
  function T(k, fb){
    return (current() === "pl" && PL[k]) ? PL[k] : fb;
  }
  function apply(l){
    try{ localStorage.setItem(KEY, l); }catch(e){}
    document.documentElement.lang = l;
    document.querySelectorAll("[data-i18n]").forEach(function(el){
      if(el.dataset.orig === undefined) el.dataset.orig = el.innerHTML;
      var v = (l === "pl") ? PL[el.dataset.i18n] : null;
      el.innerHTML = (v == null) ? el.dataset.orig : v;
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function(el){
      if(el.dataset.origPh === undefined) el.dataset.origPh = el.getAttribute("placeholder") || "";
      var v = (l === "pl") ? PL[el.dataset.i18nPh] : null;
      el.setAttribute("placeholder", (v == null) ? el.dataset.origPh : v);
    });
    document.querySelectorAll(".lang-sw button").forEach(function(b){
      b.classList.toggle("on", b.dataset.lang === l);
    });
  }
  window.rpT = T;
  window.rpLang = current;
  document.addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest(".lang-sw button") : null;
    if(!b) return;
    try{ localStorage.setItem(KEY, b.dataset.lang); }catch(err){}
    location.reload();
  });
  document.addEventListener("DOMContentLoaded", function(){ apply(current()); });
})();
