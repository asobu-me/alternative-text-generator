import * as assert from 'assert';
import { extractQueryToken, levenshtein, rankCandidates } from '../../services/imagePathResolver';

suite('imagePathResolver', () => {
    suite('extractQueryToken', () => {
        test('takes identifier after last dot inside ${...}', () => {
            assert.strictEqual(extractQueryToken('${product.image}'), 'image');
        });
        test('uses ${...} content even when wrapped in a path', () => {
            assert.strictEqual(extractQueryToken('/assets/${slug}.jpg'), 'slug');
        });
        test('returns a bare JSX variable unchanged', () => {
            assert.strictEqual(extractQueryToken('imageUrl'), 'imageUrl');
        });
        test('uses basename without extension for a plain path', () => {
            assert.strictEqual(extractQueryToken('../images/hero-banner.png'), 'hero-banner');
        });
        test('keeps underscores and digits from a filename', () => {
            assert.strictEqual(extractQueryToken('photos/IMG_1234.JPG'), 'IMG_1234');
        });
    });

    suite('levenshtein', () => {
        test('classic kitten/sitting distance is 3', () => {
            assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
        });
        test('identical strings have distance 0', () => {
            assert.strictEqual(levenshtein('hero', 'hero'), 0);
        });
    });

    suite('rankCandidates', () => {
        const files = [
            '/ws/img/footer.png',
            '/ws/img/product-image.png',
            '/ws/img/header.png'
        ];
        test('ranks a substring filename match first', () => {
            const ranked = rankCandidates('image', files);
            assert.ok(ranked[0].endsWith('product-image.png'), `got ${ranked[0]}`);
        });
        test('ranks an exact-name match first', () => {
            const ranked = rankCandidates('header', files);
            assert.ok(ranked[0].endsWith('header.png'), `got ${ranked[0]}`);
        });
        test('returns every candidate (no drops)', () => {
            assert.strictEqual(rankCandidates('x', files).length, files.length);
        });
    });
});
