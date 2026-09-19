import SwiftUI

// Duolingo-like quiz — thick borders, bubbly, progress + hearts
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
    @State private var showFeedback = false
    @State private var lastCorrect: Bool? = nil

    var body: some View {
        VStack(spacing:0){
            duoTopBar
            TabView(selection:$index){
                ForEach(Array(challenges.enumerated()), id:\.element.id){ i,ch in
                    ScrollView{
                        ChallengeCardDuo(challenge: ch, answer: binding(for: ch.id))
                            .padding(16)
                    }.tag(i)
                }
            }.tabViewStyle(.page(indexDisplayMode:.never)).animation(.easeInOut, value:index)
            // feedback banner like Duolingo
            if showFeedback, let ok = lastCorrect {
                HStack(spacing:10){
                    Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill").font(.title2).foregroundStyle(ok ? RPColor.duoGreen : Color.red)
                    VStack(alignment:.leading){ Text(ok ? "Świetnie!" : "Poprawna odpowiedź: \(correctLabel(for: challenges[index]))").font(.system(size:14, weight:.bold, design:.rounded)).foregroundStyle(ok ? RPColor.duoGreenDark : Color.red) }
                    Spacer()
                    Button(ok ? "DALEJ" : "OK") {
                        showFeedback=false
                        if index < challenges.count-1 { withAnimation{ index+=1 } }
                        else { Task{ await finish() } }
                    }.font(.system(size:13, weight:.bold, design:.rounded)).padding(.horizontal,16).padding(.vertical,10).background(ok ? RPColor.duoGreen : Color.red).foregroundStyle(.white).clipShape(Capsule())
                }.padding(14).background(ok ? RPColor.duoGreenLight : Color(hex:"#FFE5E5")).overlay(Rectangle().fill(ok ? RPColor.duoGreen : Color.red).frame(height:3), alignment:.top)
            }
            bottomBar
        }
        .background(Color.white)
        .navigationBarHidden(true)
        .navigationDestination(isPresented:$showResult){ if let proof, !results.isEmpty { ResultMinimalView(book:book, chapter:chapter, results:results, proof:proof)}}
        .overlay{ if evaluating{ VStack(spacing:8){ ProgressView(); Text("Duo ocenia…").font(.system(size:12)).foregroundStyle(RPColor.muted)} .padding(20).background(Color.white).clipShape(RoundedRectangle(cornerRadius:16)).shadow(radius:12)} }
    }

    var duoTopBar: some View {
        HStack(spacing:12){
            Button{ dismiss()} label:{ Image(systemName:"xmark").font(.system(size:16, weight:.bold)).foregroundStyle(RPColor.duoGrayDark).padding(8).background(Color.white).clipShape(Circle()).overlay(Circle().stroke(RPColor.duoGray, lineWidth:1.5))}
            // progress
            GeometryReader{ g in
                ZStack(alignment:.leading){
                    Capsule().fill(RPColor.duoGray)
                    Capsule().fill(RPColor.duoGreen).frame(width: g.size.width * CGFloat(Double(index+1)/Double(challenges.count)))
                }
            }.frame(height:12)
            // hearts / lives
            HStack(spacing:4){ Image(systemName:"heart.fill").foregroundStyle(Color.red).font(.system(size:16)); Text("5").font(.system(size:15, weight:.bold, design:.rounded)).foregroundStyle(Color.red)}
        }.padding(.horizontal,16).padding(.vertical,10).background(Color.white)
    }

    var bottomBar: some View {
        VStack(spacing:8){
            if showFeedback {
                EmptyView()
            } else if index < challenges.count - 1 {
                Button{
                    // check and show feedback before going next
                    let ch = challenges[index]
                    let ans = answers[ch.id]
                    let ok = isCorrect(ch, ans)
                    lastCorrect = ok
                    showFeedback = true
                } label: {
                    Text("SPRAWDŹ").font(.system(size:15, weight:.black, design:.rounded)).tracking(1)
                        .frame(maxWidth:.infinity).padding(.vertical,14)
                        .background(hasAnswer(for: challenges[index].id) ? RPColor.duoGreen : RPColor.duoGray).foregroundStyle(hasAnswer(for: challenges[index].id) ? .white : RPColor.duoGrayDark)
                        .clipShape(RoundedRectangle(cornerRadius:12))
                        .overlay(RoundedRectangle(cornerRadius:12).stroke(hasAnswer(for: challenges[index].id) ? RPColor.duoGreenDark : Color.clear, lineWidth:2))
                        .shadow(color: hasAnswer(for: challenges[index].id) ? RPColor.duoGreenDark.opacity(0.5) : .clear, radius:0, y:4)
                }.disabled(!hasAnswer(for: challenges[index].id)).padding(.horizontal,16).padding(.bottom,6)
            } else {
                Button{ Task{ await finish() }} label:{
                    Text("ZAKOŃCZ").font(.system(size:15, weight:.black, design:.rounded)).tracking(1)
                    .frame(maxWidth:.infinity).padding(.vertical,14)
                    .background(allAnswered ? RPColor.duoGreen : RPColor.duoGray).foregroundStyle(allAnswered ? .white : RPColor.duoGrayDark)
                    .clipShape(RoundedRectangle(cornerRadius:12))
                    .shadow(color: allAnswered ? RPColor.duoGreenDark.opacity(0.5) : .clear, radius:0, y:4)
                }.disabled(!allAnswered).padding(.horizontal,16).padding(.bottom,6)
                if !showFeedback { Button(loc.t("Pomiń","Skip")){}.font(.system(size:13)).tint(RPColor.muted) }
            }
        }.padding(.vertical,10).background(Color.white.shadow(color:.black.opacity(0.06), radius:8, y:-4))
    }

    func isCorrect(_ ch: Challenge, _ ans: UserAnswer?) -> Bool {
        switch ch.type{
        case .multipleChoice,.trueFalse,.whatNext: if case .single(let v)=ans{ return v==ch.correctAnswer } ; return false
        case .multipleSelect: if case .multiple(let s)=ans, let exp=ch.correctAnswers{ return s==Set(exp)}; return false
        case .findError: if case .single(let v)=ans{ return v==ch.errorIndex}; return false
        case .ordering,.ranking: if case .ordered(let o)=ans, let exp=ch.correctOrder{ return o==exp}; return false
        case .match,.whoSaid: if case .matched(let m)=ans{ var ok=true; for (k,v) in m{ if k != v{ ok=false}}; return ok && m.count==(ch.pairs?.count ?? 0)}; return false
        case .openQuestion,.whyQuestion: return false // handled async via Jev, just show feedback after submit; for now treat as correct if text length >10
        case .memory: return true
        }
    }
    func correctLabel(for ch: Challenge) -> String {
        if let o = ch.options, let idx = ch.correctAnswer, idx < o.count { return o[idx] }
        if let s = ch.statements, let idx = ch.errorIndex, idx < s.count { return s[idx] }
        return ""
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

struct ChallengeCardDuo: View {
    let challenge: Challenge
    @Binding var answer: UserAnswer?
    @State private var selected:Int?
    @State private var multi:Set<Int>=[]
    @State private var text:String=""
    @State private var order:[Int]=[]
    @State private var matchSel:[Int:Int]=[:]

    var body: some View {
        VStack(alignment:.leading, spacing:16){
            // Duo owl placeholder + question
            HStack(alignment:.top, spacing:12){
                ZStack{ Circle().fill(Color(hex:"#E8FFD6")).frame(width:48,height:48); Text("🦉").font(.title2)}
                Text(challenge.question).font(.system(size:20, weight:.bold, design:.rounded)).foregroundStyle(RPColor.duoText).lineSpacing(1)
            }
            if [.multipleChoice,.trueFalse,.whatNext,.findError].contains(challenge.type){
                Text("Wybierz poprawną odpowiedź").font(.system(size:12, weight:.bold)).tracking(0.6).foregroundStyle(RPColor.muted2)
            }
            content
            if challenge.type.requiresJev {
                duoReflection
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
            VStack(spacing:10){
                ForEach(Array(opts.enumerated()), id:\.offset){ i,opt in
                    let sel=selected==i
                    Button{ selected=i} label:{
                        HStack(spacing:12){
                            ZStack{ RoundedRectangle(cornerRadius:8).fill(sel ? RPColor.duoGreen : Color.white).frame(width:36,height:36).overlay(RoundedRectangle(cornerRadius:8).stroke(sel ? RPColor.duoGreenDark : RPColor.duoGray, lineWidth:2)); Text(["A","B","C","D"][min(i,3)]).font(.system(size:14, weight:.black, design:.rounded)).foregroundStyle(sel ? .white : RPColor.muted) }
                            Text(opt).font(.system(size:15, weight:.semibold, design:.rounded)).foregroundStyle(RPColor.duoText).multilineTextAlignment(.leading)
                            Spacer()
                        }.padding(12)
                        .background(sel ? RPColor.duoGreenLight : Color.white)
                        .clipShape(RoundedRectangle(cornerRadius:12))
                        .overlay(RoundedRectangle(cornerRadius:12).stroke(sel ? RPColor.duoGreen : RPColor.duoGray, lineWidth:2))
                        .shadow(color: sel ? RPColor.duoGreenDark.opacity(0.15) : .clear, radius:0, y:3)
                    }.buttonStyle(.plain)
                }
            }
        case .multipleSelect:
            VStack(spacing:10){
                ForEach(Array((challenge.options ?? []).enumerated()), id:\.offset){ i,opt in
                    let sel=multi.contains(i)
                    Button{ if sel{multi.remove(i)}else{multi.insert(i)}} label:{
                        HStack{ Text(opt).font(.system(size:14, weight:.semibold, design:.rounded)).foregroundStyle(RPColor.duoText); Spacer(); Image(systemName: sel ? "checkmark.square.fill":"square").foregroundStyle(sel ? RPColor.duoGreen : RPColor.duoGray).font(.system(size:20))}
                        .padding(14).background(sel ? RPColor.duoGreenLight : Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(sel ? RPColor.duoGreen : RPColor.duoGray, lineWidth:2))
                    }.buttonStyle(.plain)
                }
            }
        case .openQuestion,.whyQuestion:
            EmptyView()
        case .ordering,.ranking:
            VStack(spacing:8){
                ForEach(Array(order.enumerated()), id:\.offset){ pos, orig in
                    HStack{
                        Text("\(pos+1)").font(.system(size:12, weight:.black, design:.rounded)).foregroundStyle(.white).frame(width:28,height:28).background(RPColor.duoBlue).clipShape(RoundedRectangle(cornerRadius:8))
                        Text(challenge.items?[orig] ?? "?").font(.system(size:14, weight:.semibold, design:.rounded)).foregroundStyle(RPColor.duoText)
                        Spacer()
                        HStack(spacing:4){ Button{ moveUp(pos)} label:{ Image(systemName:"chevron.up").font(.caption2)} .disabled(pos==0); Button{ moveDown(pos)} label:{ Image(systemName:"chevron.down").font(.caption2)} .disabled(pos==order.count-1)}.foregroundStyle(RPColor.muted)
                    }.padding(12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.duoGray, lineWidth:2))
                }
            }.onAppear{ if order.isEmpty{ order=Array(0..<(challenge.items?.count ?? 0)).shuffled()}}
        case .match,.whoSaid:
            let pairs=challenge.pairs ?? []; let rights=pairs.map{$0.right}
            VStack(spacing:10){
                ForEach(Array(pairs.enumerated()), id:\.offset){ li,p in
                    VStack(alignment:.leading, spacing:6){
                        Text(p.left).font(.system(size:13, weight:.bold, design:.rounded)).padding(8).background(Color(hex:"#F7F7F7")).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.duoGray))
                        Picker("dopasuj", selection: Binding(get:{matchSel[li] ?? -1}, set:{matchSel[li]=$0})){
                            Text("— wybierz —").tag(-1)
                            ForEach(Array(rights.enumerated()), id:\.offset){ ri,r in Text(r).tag(ri)}
                        }.pickerStyle(.menu).tint(RPColor.duoBlue).padding(.horizontal,8).background(Color.white).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.duoGray, lineWidth:2))
                    }
                }
            }
        case .memory: Text("Mini-gra — auto-zaliczona").font(.system(size:13)).foregroundStyle(RPColor.muted)
        }
    }

    var duoReflection: some View {
        VStack(alignment:.leading, spacing:8){
            HStack{ Text("KRÓTKA REFLEKSJA").font(.system(size:11, weight:.black, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.duoText); MonoPill(text:"+1.50 USDC", fg:Color.white, bg:RPColor.peach, border:.clear); Spacer(); Text("\(text.count) / 240").font(.system(size:11, weight:.bold)).foregroundStyle(text.count>240 ? Color.red : RPColor.muted)}
            TextField("Wpisz odpowiedź własnymi słowami…", text:$text, axis:.vertical).font(.system(size:15, design:.rounded)).lineLimit(3...5).padding(12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(text.count>10 ? RPColor.duoGreen : RPColor.duoGray, lineWidth:2))
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
