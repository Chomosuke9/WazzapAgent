export class LimitedSizeCache {
  constructor(limit) {
    this.limit = limit;
    this.cache = new Map();
    for (let i = 0; i < this.limit; i++) {
        this.cache.set(Symbol(), "");
    }
  }

  set(id, value) {
    this.cache.set(id, value);
    this.cache.delete(this.cache.keys().next().value);
  }

  get(id) {
    return this.cache.get(id);
  }
}