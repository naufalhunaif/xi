
export class CartSelectionIncompleteError extends Error {
  readonly code = 'CART_SELECTION_INCOMPLETE'
  constructor() {
    super('Pilihan ukuran belum lengkap; cart belum diubah.')
  }
}
