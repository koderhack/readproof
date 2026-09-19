import SwiftUI

struct ChallengeFlowView: View {
    let book: Book
    let chapter: Chapter
    let challenges: [Challenge]
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @Environment(\.dismiss) var dismiss
    @State private var index = 0
    @State private var answers: [String: UserAnswer] = [:]
    @State private var evaluating = false
    @State private var showResult = false
    @State private var results: [ChallengeResult] = []
    @State private var proof: ReadingProof?

    var body: some View {
        VStack(spacing:0){
            TabView(selection:$index){
                ForEach(Array(challenges.enumerated()), id:\.element.id){ i,ch in
                    ScrollView{
                        ChallengeCardMinimal(challenge: ch, answer: binding(for: ch.id))
                            .padding(16)
                    }.tag(i)
                }
            }.tabViewStyle(.page(indexDisplayMode:.never)).animation(.easeInOut, value:index)
            bottomBar
        }
        .background(RPColor.bg)
        .navigationTitle(loc.t("Edytor Weryfikacji","Verification Editor"))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar{ ToolbarItem(placement:.navigationBarLeading){ Button{ dismiss()} label:{ Image(systemName:"chevron.left").font(.system(size:16, weight:.semibold)).foregroundStyle(RPColor.ink)} }
            ToolbarItem(placement:.principal){ HStack(spacing:6){ ZStack{ RoundedRectangle(cornerRadius:6).fill(RPColor.primary).frame(width:28,height:28); Image(systemName:"books.vertical.fill").foregroundStyle(.white).font(.system(size:12))}; Text(loc.t("Edytor Weryfikacji","Verification Editor")).font(.system(size:15, weight:.semibold, design:.rounded))} }
            ToolbarItem(placement:.navigationBarTrailing){ Circle().fill(Color(hex:"#E5E7EB")).frame(width:28,height:28).overlay(Image(systemName:"person.fill").font(.system(size:12)).foregroundStyle(RPColor.muted)) }
        }
        .toolbarBackground(RPColor.bg, for:.navigationBar)
        .navigationDestination(isPresented:$showResult){ if let proof, !results.isEmpty { ResultMinimalView(book:book, chapter:chapter, results:results, proof:proof)}}
        .overlay{ if evaluating{ VStack(spacing:8){ ProgressView(); Text("Jev ocenia…").font(.system(size:12)).foregroundStyle(RPColor.muted)} .padding(20).card()} }
    }

    var bottomBar: some View {
        VStack(spacing:8){
            if index < challenges.count - 1 {
                Button{
                    guard hasAnswer(for: challenges[index].id) else {return}
                    withAnimation{ index+=1}
                } label: {
                    Text(loc.t("Dalej","Next")).font(.system(size:15, weight:.semibold, design:.rounded))
                        .frame(maxWidth:.infinity).padding(.vertical,14)
                        .background(hasAnswer(for: challenges[index].id) ? RPColor.primary : Color(hex:"#E5E7EB")).foregroundStyle(hasAnswer(for: challenges[index].id) ? .white : RPColor.muted)
                        .clipShape(RoundedRectangle(cornerRadius:14))
                }.disabled(!hasAnswer(for: challenges[index].id))
            } else {
                Button{ Task{ await finish() }} label:{
                    HStack{ Image(systemName:"checkmark.shield.fill"); Text(loc.t("Zweryfikuj i wyślij dowód","Verify & submit proof")).font(.system(size:15, weight:.semibold, design:.rounded))}
                    .frame(maxWidth:.infinity).padding(.vertical,14)
                    .background(allAnswered ? RPColor.primary : Color(hex:"#E5E7EB")).foregroundStyle(allAnswered ? .white : RPColor.muted)
                    .clipShape(RoundedRectangle(cornerRadius:14))
                }.disabled(!allAnswered)
                Button(loc.t("Pomiń to pytanie","Skip question")){}.font(.system(size:13)).tint(RPColor.muted)
            }
        }.padding(16).background(Color.white.shadow(color:.black.opacity(0.06), radius:8, y:-4))
    }

    func binding(for id:String)->Binding<UserAnswer?>{ Binding(get:{answers[id]}, set:{answers[id]=$0})}
    func hasAnswer(for id:String)->Bool{ answers[id] != nil}
    var allAnswered:Bool{ challenges.allSatisfy{ answers[$0.id] != nil}}

    func finish() async {
        evaluating=true; var res:[ChallengeResult]=[]
        for ch in challenges {
            let ans=answers[ch.id]; var correct=false; var verdict:JevVerdict?=nil
            switch ch.type{
            case .multipleChoice,.trueFalse,.whatNext: if case .single(let v)=ans{ correct=v==ch.correctAnswer}
            case .multipleSelect: if case .multiple(let s)=ans, let exp=ch.correctAnswers{ correct=s==Set(exp)}
            case .findError: if case .single(let v)=ans{ correct=v==ch.errorIndex}
            case .ordering,.ranking: if case .ordered(let o)=ans, let exp=ch.correctOrder{ correct=o==exp}
            case .match,.whoSaid: if case .matched(let m)=ans{ var ok=true; for (k,v) in m{ if k != v{ ok=false}}; correct=ok && m.count==(ch.pairs?.count ?? 0)}
            case .openQuestion,.whyQuestion: if case .text(let t)=ans, let exp=ch.expectedMeaning{ let v=await JevService.shared.evaluate(question: ch.question, expectedMeaning: exp, userAnswer:t, context: ch.context ?? chapter.contextExcerpt); verdict=v; correct=v.correct && v.confidence>=Scoring.jevThreshold}
            case .memory: correct=true
            }
            res.append(ChallengeResult(id: ch.id, challenge: ch, userAnswer: ans, isCorrect: correct, jevConfidence: verdict?.confidence, jevRaw: verdict))
        }
        let score=res.filter{$0.isCorrect}.count
        let status=Scoring.status(for: score)
        let wallet=appState.wallet.address ?? "DemoWallet-\(String(UUID().uuidString.prefix(6)))"
        let now=Date()
        let hash=SolanaService.shared.createProofHash(bookId: book.id, chapterId: chapter.id, wallet: wallet, timestamp: now, score: score)
        var sig:String?=nil; var explorer:String?=nil; var reward:String?=nil
        if Scoring.isPassing(score: score){ let tx=await SolanaService.shared.sendReward(to: wallet, amount: chapter.reward, proofHash: hash); sig=tx.sig; explorer=tx.explorer; reward=chapter.reward}
        let newProof=ReadingProof(id: UUID().uuidString, bookId: book.id, chapterId: chapter.id, challengeIds: challenges.map{$0.id}, score: score, total: challenges.count, status: status, walletAddress: wallet, timestamp: now, proofHash: hash, txSignature: sig, explorerUrl: explorer, reward: reward)
        if status != .failed{ appState.saveProof(newProof)}
        results=res; proof=newProof; evaluating=false; showResult=true
    }
}

struct ChallengeCardMinimal: View {
    let challenge: Challenge
    @Binding var answer: UserAnswer?
    @State private var selected:Int?
    @State private var multi:Set<Int>=[]
    @State private var text:String=""
    @State private var order:[Int]=[]
    @State private var matchSel:[Int:Int]=[:]

    var body: some View {
        VStack(alignment:.leading, spacing:14){
            Text(challenge.question).font(.system(size:22, weight:.bold, design:.rounded)).foregroundStyle(RPColor.ink).lineSpacing(2)
            if challenge.type == .multipleChoice || challenge.type == .trueFalse || challenge.type == .whatNext || challenge.type == .findError {
                Text("WYBIERZ POPRAWNĄ ODPOWIEDŹ").font(.system(size:11, weight:.semibold, design:.rounded)).tracking(0.8).foregroundStyle(RPColor.muted)
            }
            content
            if challenge.type.requiresJev {
                reflection
            }
        }
        .onAppear{ hydrate()}
        .onChange(of:selected){_,_ in sync()}
        .onChange(of:multi){_,_ in sync()}
        .onChange(of:text){_,_ in sync()}
        .onChange(of:order){_,_ in sync()}
        .onChange(of:matchSel){_,_ in sync()}
    }

    @ViewBuilder var content: some View {
        switch challenge.type{
        case .multipleChoice,.trueFalse,.whatNext,.findError:
            let opts:[String] = { if let o=challenge.options{return o}; if let s=challenge.statements{return s}; return []}()
            VStack(spacing:0){
                ForEach(Array(opts.enumerated()), id:\.offset){ i,opt in
                    let sel=selected==i
                    Button{ selected=i} label:{
                        HStack(spacing:12){
                            ZStack{ Circle().fill(sel ? RPColor.primary : Color(hex:"#F3F4F6")).frame(width:32,height:32); Text(["A","B","C","D"][min(i,3)]).font(.system(size:13, weight:.semibold, design:.rounded)).foregroundStyle(sel ? .white : RPColor.muted) }
                            Text(opt).font(.system(size:15, design:.rounded)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading)
                            Spacer()
                            if sel{ Image(systemName:"checkmark.circle.fill").foregroundStyle(RPColor.primary).font(.system(size:18))}
                        }.padding(14).background(sel ? Color(hex:"#FFF6EE") : Color.white).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if i < opts.count-1{ Divider().padding(.leading,58).opacity(0.6)}
                }
            }.clipShape(RoundedRectangle(cornerRadius:16)).overlay(RoundedRectangle(cornerRadius:16).stroke(RPColor.line))
        case .multipleSelect:
            VStack(spacing:8){
                ForEach(Array((challenge.options ?? []).enumerated()), id:\.offset){ i,opt in
                    let sel=multi.contains(i)
                    Button{ if sel{multi.remove(i)}else{multi.insert(i)}} label:{
                        HStack{ Text(opt).font(.system(size:14, design:.rounded)); Spacer(); Image(systemName: sel ? "checkmark.square.fill":"square").foregroundStyle(sel ? RPColor.primary : RPColor.muted) }
                        .padding(14).background(sel ? RPColor.primaryLight : Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(sel ? RPColor.primary : RPColor.line))
                    }.buttonStyle(.plain)
                }
            }
        case .openQuestion,.whyQuestion:
            // handled in reflection below (reuse same text)
            EmptyView()
        case .ordering,.ranking:
            VStack(spacing:8){
                ForEach(Array(order.enumerated()), id:\.offset){ pos, orig in
                    HStack{
                        Text("\(pos+1).").font(.system(size:12, weight:.bold, design:.rounded)).foregroundStyle(RPColor.primary)
                        Text(challenge.items?[orig] ?? "?").font(.system(size:14, design:.rounded))
                        Spacer()
                        HStack(spacing:4){ Button{ moveUp(pos)} label:{ Image(systemName:"chevron.up").font(.caption2)} .disabled(pos==0); Button{ moveDown(pos)} label:{ Image(systemName:"chevron.down").font(.caption2)} .disabled(pos==order.count-1)}.foregroundStyle(RPColor.muted)
                    }.padding(12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))
                }
            }.onAppear{ if order.isEmpty{ order=Array(0..<(challenge.items?.count ?? 0)).shuffled()}}
        case .match,.whoSaid:
            let pairs=challenge.pairs ?? []; let rights=pairs.map{$0.right}
            VStack(spacing:10){
                ForEach(Array(pairs.enumerated()), id:\.offset){ li,p in
                    VStack(alignment:.leading, spacing:6){
                        Text(p.left).font(.system(size:13, weight:.semibold, design:.rounded)).padding(8).background(RPColor.primarySoft).clipShape(RoundedRectangle(cornerRadius:8))
                        Picker("dopasuj", selection: Binding(get:{matchSel[li] ?? -1}, set:{matchSel[li]=$0})){
                            Text("— wybierz —").tag(-1)
                            ForEach(Array(rights.enumerated()), id:\.offset){ ri,r in Text(r).tag(ri)}
                        }.pickerStyle(.menu).tint(RPColor.primary).padding(.horizontal,8).background(Color.white).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.line))
                    }
                }
            }
        case .memory: Text("Mini-gra — auto-zaliczona").font(.system(size:13)).foregroundStyle(RPColor.muted)
        }
    }

    var reflection: some View {
        VStack(alignment:.leading, spacing:8){
            HStack{ Text("KRÓTKA REFLEKSJA").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted); MonoPill(text:"+1.50 USDC bonus", fg:Color.white, bg:RPColor.peach, border:.clear); Spacer(); Text("\(text.count) / 240").font(.system(size:11)).foregroundStyle(RPColor.muted)}
            TextField("Opisz w 1-2 zdaniach przykład błędu kotwiczenia…", text:$text, axis:.vertical).font(.system(size:14, design:.rounded)).lineLimit(3...5).padding(12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))
                .overlay(alignment:.bottomTrailing){ Image(systemName:"square.and.pencil").foregroundStyle(RPColor.muted).padding(8)}
        }
    }

    func moveUp(_ pos:Int){ guard pos>0 else{return}; order.swapAt(pos,pos-1)}
    func moveDown(_ pos:Int){ guard pos < order.count-1 else{return}; order.swapAt(pos,pos+1)}
    func hydrate(){
        switch answer{
        case .single(let v): selected=v
        case .multiple(let s): multi=s
        case .text(let t): text=t
        case .ordered(let o): order=o
        case .matched(let m): matchSel=m
        case .none: break
        }
        if [.ordering,.ranking].contains(challenge.type), order.isEmpty, let n=challenge.items?.count{ order=Array(0..<n).shuffled()}
    }
    func sync(){
        switch challenge.type{
        case .multipleChoice,.trueFalse,.whatNext,.findError: if let s=selected{ answer = .single(s)}
        case .multipleSelect: answer = .multiple(multi)
        case .openQuestion,.whyQuestion: answer = .text(text)
        case .ordering,.ranking: answer = .ordered(order)
        case .match,.whoSaid: answer = .matched(matchSel)
        case .memory: answer = .single(0)
        }
    }
}
