import SwiftUI

struct RemoteCoverView: View {
    let book: Book
    var width: CGFloat = 92
    var height: CGFloat = 128
    var body: some View {
        Group {
            if let urlStr = book.coverUrl, let url = URL(string: urlStr) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty:
                        ZStack { RoundedRectangle(cornerRadius: 10).fill(Color(hex:"#F0E6D2")); ProgressView() }
                    case .success(let img):
                        img.resizable().scaledToFill()
                    case .failure:
                        fallback
                    @unknown default: fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.black.opacity(0.06), lineWidth: 1))
        .shadow(color:.black.opacity(0.06), radius: 6, y: 3)
    }
    var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10).fill(Color(hex:"#F0E6D2"))
            Text(book.coverEmoji).font(.system(size: 36))
        }
    }
}
