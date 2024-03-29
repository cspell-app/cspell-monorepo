import { genSequence } from 'gensequence';
import { Observable } from 'rxjs';
import { filter, map, reduce, take } from 'rxjs/operators';
import { IterableLike } from '../util/IterableLike';
import { Trie, importTrieRx, SuggestionCollector, SuggestionResult, CompoundWordsMethod } from 'cspell-trie';
import { createMapper } from '../util/repMap';
import { ReplaceMap } from '../Settings';

export {
    CompoundWordsMethod,
    JOIN_SEPARATOR,
    SuggestionCollector,
    suggestionCollector,
    SuggestionResult,
    WORD_SEPARATOR,
} from 'cspell-trie';

export type FilterSuggestionsPredicate = (word: SuggestionResult) => boolean;

export interface SpellingDictionary {
    readonly name: string;
    readonly type: string;
    readonly source: string;
    has(word: string, useCompounds?: boolean): boolean;
    suggest(word: string, numSuggestions?: number, compoundMethod?: CompoundWordsMethod, numChanges?: number): SuggestionResult[];
    genSuggestions(collector: SuggestionCollector, compoundMethod?: CompoundWordsMethod): void;
    mapWord(word: string): string;
    readonly size: number;
    readonly options: SpellingDictionaryOptions;
}

export interface SpellingDictionaryOptions {
    repMap?: ReplaceMap;
    useCompounds?: boolean;
}

const defaultSuggestions = 10;

export class SpellingDictionaryFromSet implements SpellingDictionary {
    private _trie: Trie;
    readonly mapWord: (word: string) => string;
    readonly type = 'SpellingDictionaryFromSet';

    constructor(
        readonly words: Set<string>,
        readonly name: string,
        readonly options: SpellingDictionaryOptions = {},
        readonly source = 'Set of words',
    ) {
        this.mapWord = createMapper(options.repMap || []);
    }

    get trie() {
        this._trie = this._trie || Trie.create(this.words);
        return this._trie;
    }

    public has(word: string, useCompounds?: boolean) {
        useCompounds = useCompounds === undefined ? this.options.useCompounds : useCompounds;
        useCompounds = useCompounds || false;
        const mWord = this.mapWord(word).toLowerCase();
        return this.words.has(mWord)
            || (useCompounds && this.trie.has(mWord, true))
            || false;
    }

    public suggest(
        word: string,
        numSuggestions?: number,
        compoundMethod: CompoundWordsMethod = CompoundWordsMethod.SEPARATE_WORDS,
        numChanges?: number
    ): SuggestionResult[] {
        word = this.mapWord(word).toLowerCase();
        return this.trie.suggestWithCost(word, numSuggestions || defaultSuggestions, compoundMethod, numChanges);
    }

    public genSuggestions(
        collector: SuggestionCollector,
        compoundMethod: CompoundWordsMethod = CompoundWordsMethod.SEPARATE_WORDS
    ): void {
        this.trie.genSuggestions(collector, compoundMethod);
    }

    public get size() {
        return this.words.size;
    }
}

export function createSpellingDictionary(
    wordList: string[] | IterableLike<string>,
    name: string,
    source: string,
    options?: SpellingDictionaryOptions
): SpellingDictionary {
    const words = new Set(genSequence(wordList)
        .filter(word => typeof word === 'string')
        .map(word => word.toLowerCase().trim())
        .filter(word => !!word)
    );
    return new SpellingDictionaryFromSet(words, name, options, source);
}

export function createSpellingDictionaryRx(
    words: Observable<string>,
    name: string,
    source: string,
    options?: SpellingDictionaryOptions
): Promise<SpellingDictionary> {
    const promise = words.pipe(
        filter(word => typeof word === 'string'),
        map(word => word.toLowerCase().trim()),
        filter(word => !!word),
        reduce((words: Set<string>, word: string) => words.add(word), new Set<string>()),
        map(words => new SpellingDictionaryFromSet(words, name, options, source)),
    ).toPromise();
    return promise;
}

export class SpellingDictionaryFromTrie implements SpellingDictionary {
    static readonly unknownWordsLimit = 1000;
    private _size: number = 0;
    readonly knownWords = new Set<string>();
    readonly unknownWords = new Set<string>();
    readonly mapWord: (word: string) => string;
    readonly type = 'SpellingDictionaryFromTrie';

    constructor(
        readonly trie: Trie,
        readonly name: string,
        readonly options: SpellingDictionaryOptions = {},
        readonly source = 'from trie',
    ) {
        trie.root.f = 0;
        this.mapWord = createMapper(options.repMap || []);
    }

    public get size() {
        if (!this._size) {
            // walk the trie and get the approximate size.
            const i = this.trie.iterate();
            let deeper = true;
            for (let r = i.next(); !r.done; r = i.next(deeper)) {
                // count all nodes even though they are not words.
                // because we are not going to all the leaves, this should give a good enough approximation.
                this._size += 1;
                deeper = r.value.text.length < 5;
            }
        }

        return this._size;
    }

    public has(word: string, useCompounds?: boolean) {
        useCompounds = useCompounds === undefined ? this.options.useCompounds : useCompounds;
        useCompounds = useCompounds || false;
        word = this.mapWord(word).toLowerCase();
        const wordX = word + '|' + useCompounds;
        if (this.knownWords.has(wordX)) return true;
        if (this.unknownWords.has(wordX)) return false;

        const r = this.trie.has(word, useCompounds);
        // Cache the result.
        if (r) {
            this.knownWords.add(wordX);
        } else {
            // clear the unknown word list if it has grown too large.
            if (this.unknownWords.size > SpellingDictionaryFromTrie.unknownWordsLimit) {
                this.unknownWords.clear();
            }
            this.unknownWords.add(wordX);
        }

        return r;
    }

    public suggest(
        word: string,
        numSuggestions?: number,
        compoundMethod: CompoundWordsMethod = CompoundWordsMethod.SEPARATE_WORDS,
        numChanges?: number
    ): SuggestionResult[] {
        word = this.mapWord(word).toLowerCase();
        compoundMethod = this.options.useCompounds ? CompoundWordsMethod.JOIN_WORDS : compoundMethod;
        return this.trie.suggestWithCost(word, numSuggestions || defaultSuggestions, compoundMethod, numChanges);
    }

    public genSuggestions(
        collector: SuggestionCollector,
        compoundMethod: CompoundWordsMethod = CompoundWordsMethod.SEPARATE_WORDS
    ): void {
        compoundMethod = this.options.useCompounds ? CompoundWordsMethod.JOIN_WORDS : compoundMethod;
        this.trie.genSuggestions(collector, compoundMethod);
    }
}

export function createSpellingDictionaryTrie(
    data: Observable<string>,
    name: string,
    source: string,
    options?: SpellingDictionaryOptions
): Promise<SpellingDictionary> {
    const promise = importTrieRx(data).pipe(
        map(node => new Trie(node)),
        map(trie => new SpellingDictionaryFromTrie(trie, name, options, source)),
        take(1),
    ).toPromise();
    return promise;
}
