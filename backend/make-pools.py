# -*- coding: utf-8 -*-
"""Ręcznie przygotowane pule pytań dla przedwiośnie, dziady, dziady-czesc-iii, grimm, maly-ksiaze."""
import json, sys, collections

def mc(q, o, a, ctx=""):
    return {"type":"multiple_choice","question":q,"options":o,"correctAnswer":a,"context":ctx}
def tf(q, a):
    return {"type":"true_false","question":q,"options":["Prawda","Fałsz"],"correctAnswer":a}
def ms(q, o, a, ctx=""):
    return {"type":"multiple_select","question":q,"options":o,"correctAnswers":a,"context":ctx}
def op(q, em, ctx=""):
    return {"type":"open_question","question":q,"expectedMeaning":em,"context":ctx}
def wy(q, em, ctx=""):
    return {"type":"why_question","question":q,"expectedMeaning":em,"context":ctx}

P = {}

# ── GRIMM ───────────────────────────────────────────────
P["grimm-ch1"] = [
    mc("Gdzie Kopciuszek często płakała po śmierci matki?", ["Pod orzechem laskowym przy grobie","Na targu","W kościele","U sąsiadki"],0),
    mc("Co zgubiła Kopciuszek, uciekając z królewskiego balu?", ["Jeden pantofelek","Srebrny naszyjnik","Chusteczkę","Wianek"],0),
    mc("Kto pomagał Kopciuszek wybierać soczewicę z popiołu?", ["Gołębie i inne ptaki","Macocha","Ojciec","Królewicz"],0),
    tf("Kopciuszek była córką księcia.",1),
    tf("Macocha zmuszała Kopciuszek do ciężkiej pracy w domu.",0),
    ms("Które prace musiała wykonywać Kopciuszek w domu macochy?", ["Przesiewanie soczewicy","Zamiatać podłogę","Roznosić listy","Czyścić i gotować"], [0,1,3]),
    op("Jak macocha utrudniała Kopciuszkowi pójście na królewski bal?", "zlecała ciężkie prace, sypała soczewicę w popiół, tworzyła przeszkody"),
    wy("Dlaczego gołębie i ptaki przylatywały pomagać Kopciuszkowi z soczewicą?", "była dobra i pracowita, ptaki dzięki dobroci jej pomogły"),
]
P["grimm-ch2"] = [
    mc("Kto dał Czerwonej Kapturek czerwoną czapeczkę?", ["Babcia","Matka","Wilk","Leśniczy"],0),
    mc("Kogo spotkała Czerwony Kapturek w lesie?", ["Wilka","Lisa","Niedźwiedzia","Wiewiórkę"],0),
    mc("Co Czerwony Kapturek niosła w koszyku do babci?", ["Kawałek ciasta i butelkę wina","Chleb i sól","Miód","Sery"],0),
    tf("Czerwony Kapturek zatrzymywała się w lesie, aby zerwać kwiaty dla babci.",0),
    tf("Wilk zjadł babcię, a potem przebrał się za nią, aby zwabić Czerwonego Kapturka.",0),
    ms("Które zwierzęta występują w baśni „Czerwony Kapturek”?", ["Wilk","Myśliwy (leśniczy)","Lis","Wróbel"], [0,1]),
    op("Dlaczego wilk zdążył do babci przed Czerwonym Kapturkiem?", "bo wybrał krótszą drogę, a dziewczynka w lesie zrywała kwiaty"),
    wy("Jak myśliwy uratował babcię i Czerwonego Kapturka?", "rozciął nożycami brzuch śpiącego wilka i wyciągnął ich całe i zdrowe"),
]
P["grimm-ch3"] = [
    mc("Kim był ojciec Jasia i Małgosi?", ["Drwalem","Rybakiem","Młynarzem","Szlachcicem"],0),
    mc("Czym Jaś oznaczał drogę za pierwszym razem, gdy dzieci zabłądziły w lesie?", ["Białymi kamykami","Okruchami chleba","Skrawkami ubrania","Kamykami z popiołu"],0),
    mc("Jak wyglądała chatka, którą dzieci znalazły w lesie za drugim razem?", ["Była z chleba, a dach z piernika","Była z kamienia","Była z drewna","Była z lodu"],0),
    mc("Kim była staruszka, która przyjęła dzieci w chatce z piernika?", ["Czarownicą","Babcią dzieci","Zielarką","Wdową po drwalu"],0),
    tf("Za drugim razem Jaś oznaczał drogę okruchami chleba, które zjadły ptaki.",0),
    tf("Kaczka pomogła dzieciom przeprawić się przez rzekę w drodze do ojca.",0),
    ms("Co dzieci zabrały z chatki czarownicy, zanim wróciły do ojca?", ["Perły i klejnoty","Kawałki złota i srebra","Chleb i masło","Świece"], [0,1]),
    op("Jak Małgosia uwolniła Jasia i co stało się z czarownicą?", "odpchnęła czarownicę i zamknęła ją w rozpalonym piecu, potem uwolniła Jasia"),
    wy("Dlaczego macocha namówiła ojca, aby zostawić dzieci w lesie?", "rodzina była biedna i brakowało jedzenia, chciała się pozbyć dzieci"),
]
P["grimm-ch4"] = [
    mc("Jakie słowa powtarzała zła królowa, pytając o urodę?", ["Lustereczko, powiedz przecie, kto najpiękniejszy jest na świecie","Dzwoneczku, jaka to godzina","Wietrze, przywiej wieści","Gąszczu, wskaż mi drogę"],0),
    mc("Kogo królowa wysłała, aby zabić Śnieżkę?", ["Łowczego (myśliwego)","Kuzyna","Stróża","Czarodzieja"],0),
    mc("Ilu krasnoludków przyjęło Śnieżkę do swojego domku w lesie?", ["Siedmiu","Pięciu","Dziesięciu","Trzech"],0),
    mc("Czym zła królowa ostatecznie otruła Śnieżkę?", ["Zatrutym jabłkiem","Sznurówką","Grzebieniem","Chlebem"],0),
    tf("Macocha próbowała zabić Śnieżkę na trzy sposoby.",0),
    tf("Śnieżkę obudziła z zimowego snu burza.",1),
    ms("Które z podanych rzeczy były próbami zabicia Śnieżki przez królową?", ["Sznurówka","Grzebień","Zatrute jabłko","Chusta"], [0,1,2]),
    op("Jak królowa dowiadywała się, że Śnieżka nadal żyje?", "pytała magiczne lustereczko, kto jest najpiękniejszy na świecie"),
    wy("Dlaczego krasnoludki pozwoliły Śnieżce zostać w swoim domu?", "była dobra i pracowita, gotowała i sprzątała dla nich"),
]
P["grimm-ch5"] = [
    mc("Skąd pochodziło imię Roszpunki?", ["Od rośliny, którą matka Roszpunki pragnęła i wykradał ją ojciec","Od koloru jej włosów","Od nazwy wieży","Od imienia czarownicy"],0),
    mc("Gdzie czarownica zamknęła Roszpunkę po jej uprowadzeniu od rodziców?", ["W wysokiej wieży bez schodów i drzwi","W lochu","W lesie","W pałacu"],0),
    mc("Jak książę dostawał się do wieży, w której mieszkała Roszpunka?", ["Po jej długich złotych włosach","Po drabinie","Przez sekretne drzwi","Na skrzydłach ptaka"],0),
    tf("Czarownica ukarała Roszpunkę, wycinając jej włosy i wyganiając ją w dzicz.",0),
    tf("Książę, który spadł na krzaki cierni, stracił wzrok, a uzdrowiły go łzy Roszpunki.",0),
    ms("Kto mieszkał w wieży razem z Roszpunką przed spotkaniem z księciem?", ["Czarownica","Roszpunka","Książę","Matka Roszpunki"], [0,1]),
    op("Dlaczego ojciec i matka Roszpunki dostali się w moc czarownicy?", "ojciec wykradł czarownicy rośliny z jej ogrodu i musiał oddać dziecko w zamian"),
    wy("Jak czarownica oszukała księcia, gdy Roszpunka zniknęła?", "ucięła jej warkocz i spuściła go z wieży, a kiedy książę wszedł, zaatakowała go"),
]
P["grimm-ch6"] = [
    mc("Jakie zwierzęta wyruszyły do Bremy, aby zostać muzykantami?", ["Osioł, pies, kot i kogut","Koń, krowa, owca i świnia","Osioł, wilk, lis i sokół","Kot, mysz, wrona i kaczka"],0),
    mc("Dlaczego osioł uciekł od swego gospodarza?", ["Gospodarz chciał się go pozbyć, bo osioł był już stary","Osioł się nudził","Bał się innych zwierząt","Gospodarz sprzedał farmę"],0),
    mc("Co zwierzęta znalazły wieczorem, szukając noclegu w lesie?", ["Dom pełen rozbójników","Zamek króla","Chatę myśliwych","Park dworski"],0),
    tf("Zwierzęta wystraszyły rozbójników, stojąc jedno na drugim i robiąc ogromny hałas.",0),
    tf("Osioł był najmłodszym ze zwierząt, które szły do Bremy.",1),
    ms("Które zwierzęta porzucili ich gospodarze i ruszyły razem do Bremy?", ["Osioł","Pies","Kot","Kogut"], [0,1,2,3]),
    op("Jak zwierzęta przegoniły rozbójników z leśnego domu?", "ustawiły się w piramidkę, narobiły straszliwego hałasu, więc zbójcy uciekli"),
    wy("Dlaczego zwierzęta postanowiły zostać muzykantami w Bremie?", "były stare i niechciane, liczyły, że w Bremie znajdzie się dla nich miejsce i zajęcie"),
]

# ── MAŁY KSIĄŻĘ ─────────────────────────────────────────
P["maly-ksiaze-ch1"] = [
    mc("Co przedstawiał pierwszy rysunek narratora, gdy miał sześć lat?", ["Węża boa połykającego lwa","Kapelusz","Konia","Wulkan"],0),
    mc("Co widzieli w tym rysunku dorośli?", ["Kapelusz","Węża","Smoka","Chmurę"],0),
    mc("Co narrator zrobił po tym, jak dorośli nie zrozumieli drugiego rysunku (wąż od środka)?", ["Zrezygnował z kariery malarza i zajął się lataniem","Poszedł do szkoły artystycznej","Zaczął rysować zwierzęta","Został geografem"],0),
    tf("Dorośli od razu zrozumieli, że rysunek przedstawia węża boa połykającego lwa.",1),
    tf("Narrator porzucił rysowanie węży boa, bo dorośli tego nie rozumieli.",0),
    ms("Czym zajmował się narratowie w dzieciństwie i dorosłości według tego rozdziału?", ["Rysował węże boa","Został pilotem (latał samolotami)","Zajmował się handlem dywanami","Liczył gwiazdy"], [0,1]),
    op("Dlaczego dorośli nie widzieli w rysunku narratora węża boa połykającego lwa?", "patrzyli tylko na zewnętrzny kształt i widzieli zwykły kapelusz, nie rozumieli wyobraźni"),
    wy("Dlaczego narrator przestał rysować węże boa jako dorosły?", "dorośli nie rozumieli jego rysunków i radzili zająć się pożytecznymi sprawami"),
]
P["maly-ksiaze-ch2"] = [
    mc("Gdzie wylądował narrator po awarii samolotu?", ["Na Saharze","Na morzu","W górach","Na łące pod Paryżem"],0),
    mc("O co poprosił narratora mały chłopiec, który pojawił się na pustyni?", ["Narysuj mi baranka","Narysuj mi smoka","Daj mi wody","Powiedz, jak masz na imię"],0),
    mc("Co w końcu usatysfakcjonowało chłopca jako rysunek baranka?", ["Skrzynka, w której siedzi baranek","Baranek na smyczy","Stary baran","Baranek z rogami"],0),
    tf("Narrator rozbił się na Saharze i został sam, z daleka od jakiejkolwiek miejscowości.",0),
    tf("Mały Książę od razu znał imię i zawód narratora.",1),
    ms("Które rysunki baranka narrator odrzucił, zanim Mały Książę zaakceptował skrzynkę?", ["Za małego baranka","Baranka z rogami","Starego baranka","Skrzynkę z barankiem"], [0,1,2]),
    op("Dlaczego narrator śpieszył się i martwił mimo rozmowy z Małym Księciem?", "bo został zużył wodę i musiał naprawić silnik samolotu, by wrócić"),
    wy("Dlaczego Mały Książę ucieszył się z rysunku skrzynki?", "w środku mieścił się baranek, który przecież śpi w środku"),
]
P["maly-ksiaze-ch3"] = [
    mc("Jak nazywa się planeta, z której pochodzi Mały Książę?", ["B 612","Ziemia","Asteroida 325","Gwiazda Słońce"],0),
    mc("Ile wulkanów miała planeta Małego Księcia?", ["Trzy","Siedem","Dwa","Pięć"],0),
    mc("Kto (według narratora) odkrył planetę Małego Księcia?", ["Astronom turecki","Król","Latarnik","Geograf"],0),
    tf("Planeta Małego Księcia była niewiele większa od domu.",0),
    tf("Mały Książę chciał mieć baranka, bo na jego planecie rosły niebezpieczne baobaby.",0),
    ms("Co Mały Książę robił każdego dnia na swojej małej planecie?", ["Czyścił wulkany","Wyrywał młode baobaby","Zbierał grzyby w lesie","Podlewał różę"], [0,1,3]),
    op("Po co Mały Książę prosił o baranka?", "chciał, by zjadał młode baobaby, zanim rozsadzą swoją małą planetę"),
    wy("Dlaczego narratorowi trudno było uwierzyć w istnienie planety tak małej jak dom?", "bo dorośli zwykle nie wierzą w to, czego nie widzą na rysunku"),
]
P["maly-ksiaze-ch4"] = [
    mc("Który kwiat zamieszkał na planecie Małego Księcia i stał się dla niego szczególny?", ["Róża","Orchidea","Stokrotka","Lilia"],0),
    mc("Jak zachowywała się róża wobec Małego Księcia?", ["Była próżna, wymagająca i kokieteryjna","Była pokorna","Milczała","Uciekała od niego"],0),
    mc("Po co — według róży — Mały Książę nosi kolce?", ["Aby bronić się przed zwierzętami","Aby ozdabiać gałązki","Aby przebijać baobaby","Aby czesać warkocz"],0),
    mc("Jakie drzewka trzeba było wyrywać z ziemi, zanim urosną w wielkie drzewa?", ["Baobaby","Wierzby","Sosny","Klonie"],0),
    tf("Baobaby mogły rozsadzić swoją planetę potężnymi korzeniami.",0),
    tf("Róża dokładnie i cierpliwie wyjaśniła Małemu Księciu, po co ma kolce.",1),
    ms("Jakie prace wykonywał Mały Książę na swojej planecie?", ["Czyścił wulkany","Wyrywał baobaby","Podlewał i chronił różę","Budował płoty"], [0,1,2]),
    op("Dlaczego róża wydawała się kapryśna i wymagająca?", "była próżna i kokieteryjna, chciała, by Mały Książę o nią dbał"),
    wy("Dlaczego wyrywanie baobabów było na małej planecie sprawą życia lub śmierci?", "dorosłe baobaby rozsadziłyby planetę ogromnymi korzeniami"),
]
P["maly-ksiaze-ch5"] = [
    mc("Kogo Mały Książę NIE odwiedził podczas wędrówki po kolejnych planetach?", ["Rybaka","Króla","Latarnika","Geografa"],0),
    mc("Co robił król na pierwszej z odwiedzonych planet?", ["Wydawał rozkazy","Gotował obiady","Sprzedawał mapy","Policza gwiazdy dla zabawy"],0),
    mc("Dlaczego pijak, którego spotkał Mały Książę, pił?", ["Bo się wstydził, że pije","Bo była mu zimno","Bo lubił smak wina","Bo był zmęczony"],0),
    mc("Co liczył biznesmen na czwartej planecie?", ["Gwiazdy","Pieniądze","Owce","Wulkany"],0),
    mc("Dlaczego latarnik musiał coraz częściej zapalać i gasić latarnię?", ["Jego planeta obracała się coraz szybciej","Miał za dużo lamp","Się nudził","Taka była umowa"],0),
    mc("Kim był geograf i co robił zgodnie ze swoim zawodem?", ["Nie wyruszał w podróże, tylko spisywał relacje podróżników","Pływał na statkach","Bić monety","Liczył gwiazdy"],0),
    tf("Pyszałek na swojej planecie kłaniał się tylko sam sobie.",0),
    tf("Latarnik był zdaniem narratora wart szacunku, bo sumiennie wypełniał swój obowiązek.",0),
    ms("Których mieszkańców spotkał Mały Książę na kolejnych planetach?", ["Króla","Pyszałka","Latarnika","Geografa"], [0,1,2,3]),
    op("Czego nauczył się Mały Książę od latarnika, który trudził się przy lampie?", "że sumienna praca i wierność obowiązkowi są cenne, nawet jeśli wydają się dziwne"),
    wy("Po co biznesmen liczył gwiazdy?", "bo uważał, że je posiada, i chciał je zamknąć w banku jak majątek"),
]
P["maly-ksiaze-ch6"] = [
    mc("Z kim Mały Książę zaprzyjaźnił się na Ziemi, zanim spotkał ogród róż?", ["z lisa","ze słoniem","z wężem","ze stadem ptaków"],0),
    mc("Co — według lisa — oznacza „oswoić”?", ["Stworzyć więzy i być dla kogoś wyjątkowym","Wypuścić zwierzę na wolność","Wyleczyć","Nakarmić"],0),
    mc("Które zdanie jest sekretem lisa przekazanym Małemu Księciu?", ["Ważne jest to, co niewidoczne dla oczu","Trzeba dużo mówić","Gwiazdy są zimne","Ziemia jest największa"],0),
    mc("Dlaczego róża Małego Księcia była dla niego wyjątkowa, mimo że w ogrodzie były tysiące róż?", ["Bo ją oswoił i poświęcił jej czas","Bo miała kolce","Bo była czerwona","Bo rosła najbliżej"],0),
    tf("Lis poprosił Małego Księcia, aby go oswoił.",0),
    tf("Według lisa wszystkie róże są sobie zupełnie obojętne i nic ich nie różni.",1),
    ms("Które rady podaje lis mówiąc o oswajaniu?", ["Bądź cierpliwy","Zbliżaj się powoli","Uciekaj, gdy ktoś przyjdzie","Poświęć drugiemu czas"], [0,1,3]),
    op("Jaki sekret wyjaśnia lis Małemu Księciu?", "najważniejsze jest niewidoczne dla oczu, widzi się dobrze tylko sercem"),
    wy("Dlaczego Mały Książę powtarza, że odpowiada za swoją różę?", "bo ją oswoił, poświęcił jej czas, jest mu bliska i droga"),
]

# ── DZIADY CZĘŚĆ II ─────────────────────────────────────
P["dziady-ch1"] = [
    mc("Gdzie odbywa się obrzęd Dziadów w części II?", ["W kaplicy na cmentarzu","W zamku","W karczmie","W lesie"],0),
    mc("Kto przewodzi obrzędowi i przywołuje duchy?", ["Guślarz","Ksiądz","Wójt","Starzec z brodą"],0),
    mc("O jakiej porze odbywa się nocne czuwanie?", ["Około północy","O świcie","W południe","Przed zachodem"],0),
    mc("W jakim celu ludzie zebrali się na Dziady?", ["By pomóc duszom zmarłych modlitwą i zapalonym ogniem","Dla zabawy","By wróżyć pogodę","By wybierać wójta"],0),
    tf("Guślarz przywołuje duchy, aby mogły zaznać ulgi i odejść w spokoju.",0),
    tf("Obrzęd Dziadów odbywa się w biały dzień, przy pełnym słońcu.",1),
    ms("Jakie elementy towarzyszą obrzędowi w kaplicy?", ["Ciemność","Zgaszone światło","Płomień (świeca/ogran)","Dzwonki weselne"], [0,1,2]),
    op("Na czym polega obrzęd Dziadów według słów Guślarza?", "nocne przywoływanie dusz zmarłych i pomaganie im modlitwą, by zaznały spokoju"),
    wy("Dlaczego ludzie gromadzili się na Dziady w ciemną noc?", "bo wierzono, że właśnie wtedy dusze zmarłych przychodzą na świat, aby szukać pomocy"),
]
P["dziady-ch2"] = [
    mc("Które dusze Guślarz nazywa „duszami lekkimi”?", ["Dzieci, które nie zaznały goryczy życia","Dorosłych, którzy wiele wycierpieli","Zbrodniarzy","Dusze śpiących rybaków"],0),
    mc("Jakiej pokarmy prosiły dusze lekkie podczas obrzędu?", ["Mleko białe i ser bielony","Chleb i miód","Wino i mięso","Gorzką wodę"],0),
    mc("Jaka zasada dla dusz lekkich brzmi w pieśni chóru?", ["Kto nie zaznał goryczy ni razu, ten nie dozna słodyczy w niebie","Kto pracował, ten spokojnie śpi","Każdy grzech ma swoją cenę","Dusze wolą ciszę"],0),
    mc("Komu w obrzędzie składano pomoc i o kogo modlono się szczególnie?", ["O dusze zmarłych i cierpiących","O królów","O zwierzęta","O pogodę"],0),
    tf("Dusze lekkie pochodzą od dzieci, które przedwcześnie zeszły z tego świata.",0),
    tf("Każda dusza, bez względu na swoje czyny, od razu trafia do nieba.",1),
    ms("Które kategorie dusz pojawiają się w obrzędzie?", ["Dusze lekkie","Dusze ciężkie","Dusze pośrednie","Dusze królów"], [0,1,2]),
    op("Co według obrzędu mogą zyskać dusze dzięki modlitwie żywych?", "prawo do zaznania słodyczy nieba i wyrwanie się z męki pamięci"),
    wy("Dlaczego dusze lekkie, które nie zaznały goryczy, nie mogą wejść do nieba?", "bo nieśmiertelność i słodycz nieba trzeba wypracować także przez trud życia na ziemi"),
]
P["dziady-ch3"] = [
    mc("Kto komentuje i przestrzega wobec przywoływanych duchów, powtarzając strofy chóru?", ["Chór zgromadzonych","Ksiądz","Guślarz sam do siebie","Uczniowie w ciszy"],0),
    mc("O czym — według Guślarza — świadczy męka dusz, które „niedokończyły” spraw życia?", ["O niespełnionej przeszłości, której nie można powetować","O zbyt długim śnie","O strachu przed ogniem","O braku wiary w Boga"],0),
    mc("Jak zakończyło się spotkanie z ostatnim tajemniczym widmem?", ["Guślarz nie potrafił go odprawić i był poruszony","Widmo samo zniknęło","Chór przegnał je śpiewem","Wszyscy spokojnie odeszli do domów"],0),
    mc("Co słychać w zapowiedzi nadejścia dusz w kaplicy?", ["Ciemno wszędzie, głucho wszędzie","Muzykę skrzypiec","Śmiech dzieci","Dzwony kościelne"],0),
    tf("Chór odpowiadał Guślarzowi i powtarzał rymowane strofy w trakcie obrzędu.",0),
    tf("Po zakończeniu obrzędu wszystkie dusze odeszły w pełnym spokoju i zadowoleniu.",1),
    ms("Jakie zjawiska zwiastują pojawienie się duchów w kaplicy?", ["Ciemność","Głusza (cisza)","Migający płomień","Gwar wesela"], [0,1,2]),
    op("Jaki sens ma przestroga, że dusze muszą zaznać goryczy, by doznać słodyczy nieba?", "życie doczesne i jego trudy są warunkiem zasłużenia na wieczny spokój"),
    wy("Dlaczego ostatnie widmo nie mogło zostać odesłane modlitwą?", "bo jego sprawa na ziemi pozostała niespełniona i nic nie mogło mu już przynieść ulgi"),
]

# ── DZIADY CZĘŚĆ III ────────────────────────────────────
P["dziady-czesc-iii-ch1"] = [
    mc("W jakim miejscu przebywa Konrad na początku Sceny I?", ["W celi więziennej","W pałacu","W kościele","W karczmie"],0),
    mc("W którym mieście rozgrywa się Scena I części III?", ["Wilnie","Warszawie","Petersburgu","Krakowie"],0),
    mc("Jakie uczucia ogarniały Konrada w celi przed wielką improwizacją?", ["Samotność, smutek i napięcie","Radość","Obojętność","Senność"],0),
    tf("W celi obok Konrada przebywali także inni więźniowie.",0),
    tf("Konrad w Scenie I spokojnie grał w karty z przyjaciółmi.",1),
    ms("Czym więźniowie zajmowali się spędzając czas w celi?", ["Rozmowami","Wspomnieniami i opowiadaniem snów","Śpiewaniem pieśni więziennych","Polowaniem na ptaki"], [0,1,2]),
    op("Dlaczego Konrad mimo zamknięcia w celi przygotowywał się do wielkiej improwizacji?", "chciał jako poeta przemówić do Boga w imieniu cierpiącego narodu"),
    wy("Dlaczego mury celi i obecność więźniów wzmacniały w Konradzie poczucie misji?", "czuł się jednym z prześladowanych i powołanym do mówienia za cały naród"),
]
P["dziady-czesc-iii-ch2"] = [
    mc("Jak nazywa się wielka wypowiedź Konrada skierowana do Boga w części III?", ["Wielka improwizacja","Modlitwa","Spowiedź","Odprawa"],0),
    mc("Do kogo zwraca się Konrad w wielkiej improwizacji?", ["Do Boga","Do Maryi","Do cara","Do muzy"],0),
    mc("Czego pragnie Konrad dla swego narodu w tej mowie?", ["Wolności, uznania i miłości Boga","Bogactwa","Sławy osobistej","Pokoju z Rosją"],0),
    mc("Kim czuje się Konrad, wypowiadając słowa władzy nad światem?", ["Mistrzem słowa, który chce rządzić sercami","Zwykłym pisarzem","Agentem carskim","Słuchaczem"],0),
    tf("Improwizacja to monolog, w którym Konrad domaga się „rządu dusz” i pamięci o swoim narodzie.",0),
    tf("Konrad w improwizacji uniżenie prosi Boga o drobne łaski dla siebie.",1),
    ms("Które cechy charakteryzują wielką improwizację Konrada?", ["Monolog do Boga","Poczucie jedności z narodem","Skarga na cierpienie uwięzionych","Pokorna modlitwa różańcowa"], [0,1,2]),
    op("Jakiej władzy i odpowiedzialności domaga się Konrad wobec nieba?", "chce władzy rządu dusz i prawa mówienia w imieniu narodu, który cierpi"),
    wy("Dlaczego Konrad czuje się powołany do rozmowy z Bogiem?", "jest poetą-mistrzem i czuje się spleciony z losem całego narodu"),
]
P["dziady-czesc-iii-ch3"] = [
    mc("W jakiej atmosferze — według streszczenia — dokonuje się tu duchowa odnowa?", ["W ciszy i modlitwie","Wśród gwaru","Podczas uczty","W czasie burzy"],0),
    mc("Kto w tym fragmencie modli się i oddaje Bogu sprawę narodu?", ["Ksiądz Piotr","Konrad","Car","Zofia"],0),
    mc("O co przede wszystkim modli się ta osoba?", ["O Polskę, o sens cierpienia i odrodzenie narodu","O osobiste bogactwo","O uwolnienie z celi","O zwycięstwo w wyborach"],0),
    tf("Modlitwa w tej scenie ma wymiar metafizyczny i dotyczy losu całego narodu.",0),
    tf("Ksiądz Piotr modlił się samotnie w spokojnej ciszy nocy.",0),
    ms("Które motywy towarzyszą modlitwie o odnowę?", ["Cisza i samotność","Wiara w zmartwychwstanie narodu","Pokora","Zabawa i tańce"], [0,1,2]),
    op("Jaką rolę pełni modlitwa księdza Piotra w części III?", "daje nadzieję, że cierpienie narodu ma sens i zapowiada jego odrodzenie (mesjanizm)"),
    wy("Dlaczego postawa księdza Piotra kontrastuje z buntem Konrada z improwizacji?", "ks. Piotr pokornie zawierza Bogu, Konrad się buntuje — pycha zderza się z pokorą"),
]
P["dziady-czesc-iii-ch4"] = [
    mc("Co ksiądz Piotr ujrzał w swojej mistycznej wizji?", ["Przyszłość Polski i sens jej cierpienia","Kraj przyszły pełen bogactwa","Drogę na zesłanie","Gospodarstwo wiejskie"],0),
    mc("Jak ksiądz Piotr odczytuje cierpienie i ofiarę Polski?", ["Jako zapowiedź zmartwychwstania narodu","Jako karę bez nadziei","Jako zwykłą klęskę","Jako karę za grzechy jednostek"],0),
    mc("Co według wizji ma się narodzić z ofiary i cierpienia?", ["Odrodzona, wolna Polska","Nowe cesarstwo","Nowa stolica","Sejm"],0),
    tf("Widzenie księdza Piotra dotyczy przyszłego losu Polski i duchowego zwycięstwa.",0),
    tf("Ksiądz Piotr ujrzał w wizji obraz narodu skazanego na wieczne zapomnienie.",1),
    ms("Które motywy pojawiają się w widzeniu księdza Piotra?", ["Droga krzyżowa narodu","Ofiara i odkupienie","Zmartwychwstanie","Ucieczka za granicę"], [0,1,2]),
    op("Jakie znaczenie ma w wizji księdza Piotra obraz Polski cierpiącej i zmartwychwstałej?", "cierpienie ma wartość odkupieńczą, a naród — jak Chrystus — odrodzi się z ofiary"),
    wy("Dlaczego wizję księdza Piotra nazywamy mesjanistyczną?", "bo ukazuje ofiarę jednej ofiary/narodu jako drogę do wyzwolenia i zmartwychwstania"),
]
P["dziady-czesc-iii-ch5"] = [
    mc("Gdzie rozgrywa się scena salonu warszawskiego?", ["W warszawskim salonie","W celi","W letnim pałacu cara","W teatrze"],0),
    mc("O czym rozmawia towarzystwo w salonie?", ["O kwestii polskiej i sytuacji narodu","O nowych strojach","O polowaniach","O podatkach"],0),
    mc("Jak rozmawiano o sprawie wolności w salonie?", ["Ostrożnie, półsłówkami, w obawie przed donosami","Głośno i nieustannie wzywając do walki","W ogóle nie poruszano tego tematu","Śpiewając pieśni powstańcze"],0),
    tf("W salonie obecni bali się donosów i cenzury ze strony zaborcy.",0),
    tf("Wszyscy w salonie otwarcie i bez obaw wzywali do zbrojnego powstania.",1),
    ms("Które wątki pojawiały się w rozmowach salonowych?", ["Strach przed donosami","Obrona polszczyzny i polskiej kultury","Los uwięzionych","Sport i zabawa"], [0,1,2]),
    op("Jak carskie represje wpływały na sposób rozmowy o wolności w salonie?", "cenzura i strach przed donosami wymuszały półsłówka, niedopowiedzenia i ostrożność"),
    wy("Dlaczego towarzystwo w salonie mówiło o sprawach narodu tylko przyciszonym głosem?", "bo instytucje carskie śledziły i karały za otwarte mówienie o wolności"),
]
P["dziady-czesc-iii-ch6"] = [
    mc("Gdzie rozgrywa się Scena dotycząca senatora?", ["W Wilnie, w siedzibie senatora","W Petersburgu","W salonie warszawskim","W klasztorze"],0),
    mc("Jak zachowuje się senator (Nowosilcow) wobec więźniów i ich spraw?", ["Bezwzględnie i urzędniczo, dbając głównie o własną karierę","Łagodnie i sprawiedliwie","Uwalnia wszystkich","Żartobliwie"],0),
    mc("Czego obawia się senator, przygotowując raport dla cara?", ["Że jego zaniedbania wyjdą na jaw","Że więźniowie uciekną","Że sam zostanie nagrodzony","Że wybuchnie powstanie w Wilnie"],0),
    mc("Jak traktował senator ludzi oskarżanych bez dowodów?", ["Z bezwzględnością i obojętnością","Z troską","Z uśmiechem i serdecznością","Z litością"],0),
    tf("Senator dba o uczciwe i sprawiedliwe rozpatrzenie spraw więźniów.",1),
    tf("Postawa senatora ukazuje zepsucie i strach urzędniczej władzy carskiej.",0),
    ms("Które cechy senatora ujawnia ta scena?", ["Zarozumiałość","Strach przed carską kontrolą","Obojętność na los ludzi","Odwagę i miłosierdzie"], [0,1,2]),
    op("Jaki obraz władzy carskiej wyłania się ze sceny z senatorem?", "władza urzędnicza, okrutna, obojętna na ludzi, dbająca tylko o własne stanowisko"),
    wy("Dlaczego senator bał się raportu dla cara, mimo że miał władzę nad więźniami?", "bo sam był śledzony i rozliczany, a kariera zależała od łaski cara"),
]

# ── PRZEDWIOŚNIE ────────────────────────────────────────
P["przedwiosnie-ch1"] = [
    mc("W którym mieście wychowywał się Cezary Baryka?", ["Baku","Warszawie","Moskwie","Lwowie"],0),
    mc("Jakie imię nosił ojciec Cezarego?", ["Seweryn","Bazyli","Tymoteusz","Konrad"],0),
    mc("Jakie imię nosiła matka Cezarego?", ["Jadwiga","Helena","Maria","Zofia"],0),
    mc("Z czego słynęło miasto Baku, w którym mieszkały Baryki?", ["Z wydobycia ropy naftowej","Z hodowli bydła","Z handlu herbatą","Z budowy okrętów"],0),
    mc("Za co Cezary został ukarany w gimnazjum?", ["Za udział w uczniowskiej demonstracji","Za złe oceny","Za kradzież","Za palenie papierosów"],0),
    tf("Baku było miastem naftowym, a ojciec Cezara pracował w przemyśle naftowym.",0),
    tf("Cezary dorastał w Warszawie przy rodzinie królewskiej.",1),
    ms("Które elementy opisują świat dzieciństwa Cezara w Baku?", ["Naftowe miasto","Szkoła i koledzy","Demonstracje młodzieży","Karnawał w stolicy"], [0,1,2]),
    op("Dlaczego Cezary został ukarany w gimnazjum?", "bo brał udział w uczniowskiej demonstracji i stanął w konflikcie z władzami szkolnymi"),
    wy("Dlaczego Baku było ważnym miejscem w historii rodziny Baryków?", "bo tam Cezary się wychował, a ojciec pracował w przemyśle naftowym, zanim nastąpiła rewolucja"),
]
P["przedwiosnie-ch2"] = [
    mc("Jakie wydarzenia historyczne towarzyszą opuszczeniu Baku przez Baryków?", ["Rewolucja rosyjska i wojny","Wojna z Turcją","Powstanie styczniowe","Najazd tatarski"],0),
    mc("Kogo Cezary zabrał ze sobą, uciekając na zachód przez Rosję?", ["Ojca Seweryna","Matkę Jadwigę","Ciotkę","Brata"],0),
    mc("Kto zmarł jeszcze w Baku w czasie rewolucji?", ["Matka Jadwiga","Ojciec Seweryn","Kuzyn","Dziadek"],0),
    mc("Przez jakie tereny wędrowali Cezary i jego ojciec?", ["Przez zrewolucjonizowaną Rosję","Przez Afrykę","Przez Chiny","Przez Grecję"],0),
    tf("Cezary uciekał na zachód razem z matką, wśród głodu, chorób i niebezpieczeństw.",1),
    tf("Podczas rewolucji Cezary i jego ojciec zostali w Baku i prowadzili interesy.",1),
    ms("Które trudy towarzyszyły ucieczce Cezara i ojca?", ["Głód","Choroby","Kontrole i napaści ze strony rewolucjonistów","Wygodne podróże koleją"], [0,1,2]),
    op("Dlaczego Cezary i jego ojciec opuścili Baku?", "w wojnie i rewolucji zginęła matka, a mienie rodziny przepadło; ocalały ojciec wraz z synem nie mieli już czego szukać w zniszczonym Baku i dążyli do Polski"),
    wy("Dlaczego droga przez Rosję do Europy była bardzo niebezpieczna?", "trwała wojna, panował głód, bieda, niepewność i ataki uzbrojonych grup"),
]
P["przedwiosnie-ch3"] = [
    mc("Do jakiego kraju — odzyskującego niepodległość — wędruje Cezary na końcu drogi?", ["Polski","Czech","Węgier","Rumunii"],0),
    mc("Co Cezary obserwuje po powrocie — pierwszy ogląd rzeczywistości odrodzonego kraju?", ["Spory o ziemię, biedę i zniszczenia","Kolorowe jarmarki","Karnawał","Widoki na szybki dobrobyt"],0),
    mc("Kto w powieści przedstawiał wizję nowoczesnej Polski nazwaną „szklane domy”?", ["Ojciec Seweryn","Matka Jadwiga","Warszawski architekt","Bojownik z powstania"],0),
    mc("Co symbolizują „szklane domy” w powieści Żeromskiego?", ["Nowoczesną, zamożną i sprawiedliwą Polskę","Szklarnie dla warzyw","Wille magnatów","Domy towarowe"],0),
    tf("Po powrocie Cezary zastał kraj w pełni odbudowany i bez konfliktów.",1),
    tf("Obraz Polski po wojnie odbiegał od marzeń o „szklanych domach”.",0),
    ms("Które obrazy „nowej” Polski widzi Cezary po przyjeździe?", ["Zniszczona wojną zabudowa","Spory o ziemię","Ubóstwo ludności","Wspaniała nowoczesna infrastruktura"], [0,1,2]),
    op("Jak „szklane domy” miały się do marzeń Cezara o idealnym państwie?", "to wizja nowoczesnej, sprawiedliwej i dostatniej Polski, której nie znalazł po powrocie"),
    wy("Dlaczego marzenie o „szklanych domach” pozostawało dla Cezara tylko ideałem?", "bo rzeczywistość odrodzonej Polski: bieda i spory, daleka była od tej wizji"),
]
P["przedwiosnie-ch4"] = [
    mc("W którym mieście rozgrywa się końcowa część powieści?", ["W Warszawie","We Lwowie","W Gdańsku","W Poznaniu"],0),
    mc("Jak Cezary odnajduje się w stolicy odradzającego się państwa?", ["Z zawodem i rozczarowaniem, widząc nędzę i konflikty","Z pełnym szczęściem i karierą","Z dostojnym urzędem","Ze spokojnym życiem rodzinnym"],0),
    mc("W co zostaje wciągnięty Cezary pod koniec powieści?", ["W demonstrację robotników","W proces sądowy","W wybory miejskie","W ślub"],0),
    tf("Końcowa scena powieści pozostawia pytanie, czy Cezary dołączy do rewolucyjnego wystąpienia.",0),
    tf("Cezary w Warszawie od razu osiągnął bogactwo i wygodne życie.",1),
    ms("Które nastroje towarzyszą Cezaremu w końcowej części?", ["Rozczarowanie rzeczywistością","Pragnienie zmian","Niepokój o przyszłość kraju","Całkowita bezczynność"], [0,1,2]),
    op("Dlaczego Cezary czuje rozczarowanie odbudowaną Polską?", "widzi biedę, nierówności i konflikty, dalekie od marzeń o idealnym państwie"),
    wy("Dlaczego ostatnia scena powieści jest otwarta i niejednoznaczna?", "autor nie daje jednoznacznej odpowiedzi na pytanie o wybór Cezara między ideami"),
]

# ── walidacja ───────────────────────────────────────────
errs = []
for cid, pool in P.items():
    seen = set()
    for i, c in enumerate(pool):
        c["id"] = f"{cid}-q{i+1}"
        c["difficulty"] = "easy"
        if not c.get("question"):
            errs.append(f"{cid}: braku pytania {i}")
        if c["type"] in ("multiple_choice","what_next","true_false"):
            if not isinstance(c.get("correctAnswer"), int) or not (0 <= c["correctAnswer"] < len(c["options"])):
                errs.append(f"{cid}: zła correctAnswer {c.get('correctAnswer')} / options {len(c['options'])}")
        if c["type"] == "multiple_select":
            if not isinstance(c.get("correctAnswers"), list) or any(not isinstance(a,int) or not (0<=a<len(c["options"])) for a in c["correctAnswers"]):
                errs.append(f"{cid}: złe correctAnswers {c.get('correctAnswers')}")
            if not c["correctAnswers"]: errs.append(f"{cid}: puste correctAnswers")
        if c["type"] in ("open_question","why_question"):
            if not c.get("expectedMeaning"): errs.append(f"{cid}: brak expectedMeaning")
        if c["id"] in seen: errs.append(f"{cid}: duplikat id")
        seen.add(c["id"])
if errs:
    print("BŁĘDY:\n"+"\n".join(errs)); sys.exit(1)

# ── scal z challenges.json ──────────────────────────────
data = json.load(open("challenges.json"))
for cid in P: data["challengesByChapter"][cid] = P[cid]
data["challengesByChapter"] = {k:v for k,v in data["challengesByChapter"].items() if v}
json.dump(data, open("challenges.json","w"), ensure_ascii=False, indent=1)
print("OK — pule:", {cid:len(p) for cid,p in P.items()})