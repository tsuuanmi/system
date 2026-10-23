"""Golden datasets for the exact paired sign-flip test of @tsuuanmi/system-statistics
(docs/design/statistics.md#golden-tests), generated once with SciPy as the reference and
committed. The TypeScript tests read the fixture; nothing runs Python at test time.

Run from the repository root (SciPy and NumPy go to uv's cache, never into the repository):

  uv run --no-project --python 3.14.2 --with scipy==1.18.1 --with numpy==2.5.4 \
    python -I scripts/statistics/sign-flip-goldens.py packages/statistics/tests/fixtures/sign-flip.scipy.json

- Every p-value is SciPy's own: `scipy.stats.permutation_test` with
  `permutation_type='samples'` and `n_resamples=inf`, which enumerates all 2^n sign vectors.
  The paired form takes (candidate, baseline) with the statistic mean(candidate - baseline); the
  one-sample form (a sign flip of each observation) checks the intervals.
- A dataset written as integers over a divisor (decimal data) also records SciPy's p-values on
  the integers themselves (`exact`): the sign-flip test is scale-free, so those are the decimal
  data's p-values in exact arithmetic, whatever rounding the decimals carry.
- Each interval is the exact inversion of the same test: the K-th smallest and largest mean of a
  non-empty subset of the differences, K = floor((1 - confidence) * 2^(n-1)), unbounded when
  K = 0. It is computed here as the library computes it (the pairs in the library's canonical
  order, each subset's sum built in that order), and checked against SciPy: just outside each
  bound SciPy's one-sided test rejects at (1 - confidence) / 2, just inside it does not.

Deterministic: no clock and no unseeded draw. The output names the versions it ran with.
"""

import json
import math
import platform
import re
import sys

import numpy as np
import scipy
from scipy import stats

CONFIDENCES = [0.8, 0.9, 0.95, 0.99, 0.999]
BATCH = 2**14


def paired_p(candidate, baseline, alternative):
    """SciPy's exact paired p-value and statistic: the pairs' arms swapped in every way."""
    result = stats.permutation_test(
        (np.asarray(candidate, dtype=np.float64), np.asarray(baseline, dtype=np.float64)),
        lambda x, y, axis: np.mean(x - y, axis=axis),
        permutation_type='samples', vectorized=True, n_resamples=np.inf, batch=BATCH, alternative=alternative,
    )
    return float(result.pvalue), float(result.statistic)


def one_sample_p(values, alternative):
    """SciPy's exact one-sample sign-flip p-value: the sign of each observation flipped in every way."""
    result = stats.permutation_test(
        (np.asarray(values, dtype=np.float64),),
        lambda x, axis: np.mean(x, axis=axis),
        permutation_type='samples', vectorized=True, n_resamples=np.inf, batch=BATCH, alternative=alternative,
    )
    return float(result.pvalue)


def canonical(candidate, baseline):
    """The library's canonical order: pairs by difference, then candidate, then baseline."""
    return sorted(((c - b, c, b) for c, b in zip(candidate, baseline)))


def subset_means(differences):
    """Every non-empty subset's mean, each sum built in the given order (as the library builds it)."""
    sums = np.zeros(1, dtype=np.float64)
    sizes = np.zeros(1, dtype=np.int64)
    for d in differences:
        sums = np.concatenate([sums, sums + d])
        sizes = np.concatenate([sizes, sizes + 1])
    return np.sort(sums[1:] / sizes[1:])


def interval(differences, confidence):
    n = len(differences)
    alpha = 1.0 - confidence
    rank = math.floor(alpha * 2.0 ** (n - 1))
    means = subset_means(differences)
    # Means closer than this to a bound are taken as the bound itself (a tie up to rounding), so
    # every point checked lies well away from every subset mean.
    near = 2.0 ** -30 * (1.0 + max(abs(d) for d in differences))
    checks = []

    def check(bound, side, delta):
        shifted = [d - delta for d in differences]
        alternative = 'greater' if bound == 'lower' else 'less'
        p = one_sample_p(shifted, alternative)
        rejected = p <= alpha / 2
        if rejected != (side == 'outside'):
            raise AssertionError(f'SciPy disagrees with the {bound} bound at confidence {confidence}: '
                                 f'p({alternative}) = {p} at delta {delta}, {side}')
        checks.append({'bound': bound, 'side': side, 'delta': delta, 'alternative': alternative, 'p': p})

    def between(a, b):
        mid = a + (b - a) / 2
        return mid if a < mid < b else None

    def below(value):
        i = int(np.searchsorted(means, value - near, side='left'))
        return float(means[i - 1]) if i > 0 else None

    def above(value):
        i = int(np.searchsorted(means, value + near, side='right'))
        return float(means[i]) if i < len(means) else None

    lowest, highest = float(means[0]), float(means[-1])
    reach = max(1.0, abs(lowest), abs(highest))
    if rank == 0:
        # Unbounded: no shift is ever rejected, however far.
        check('lower', 'inside', lowest - reach)
        check('upper', 'inside', highest + reach)
        return {'confidence': confidence, 'rank': 0, 'lower': None, 'upper': None, 'checks': checks}
    lower = float(means[rank - 1])
    upper = float(means[len(means) - rank])
    for bound, value in (('lower', lower), ('upper', upper)):
        outside_neighbour, inside_neighbour = (below(value), above(value)) if bound == 'lower' else (above(value), below(value))
        far = value - reach if bound == 'lower' else value + reach
        outside = far if outside_neighbour is None else between(*sorted((outside_neighbour, value)))
        inside = between(*sorted((inside_neighbour, value))) if inside_neighbour is not None else None
        if outside is not None:
            check(bound, 'outside', outside)
        if inside is not None:
            check(bound, 'inside', inside)
    return {'confidence': confidence, 'rank': rank, 'lower': lower, 'upper': upper, 'checks': checks}


def dataset(id_, about, candidate, baseline, exact=None):
    pairs = canonical(candidate, baseline)
    differences = [d for d, _, _ in pairs]
    out = {'id': id_, 'about': about, 'candidate': candidate, 'baseline': baseline}
    scipy_ = {}
    for alternative in ('greater', 'less', 'two-sided'):
        p, statistic = paired_p(candidate, baseline, alternative)
        scipy_[alternative] = p
        scipy_['statistic'] = statistic
    out['scipy'] = scipy_
    if exact is not None:
        ints_candidate, ints_baseline, divisor = exact
        out['exact'] = {
            'divisor': divisor,
            'candidate': ints_candidate,
            'baseline': ints_baseline,
            **{alternative: paired_p(ints_candidate, ints_baseline, alternative)[0] for alternative in ('greater', 'less', 'two-sided')},
        }
    out['intervals'] = [interval(differences, c) for c in CONFIDENCES]
    print(f'{id_}: n={len(candidate)} done', file=sys.stderr, flush=True)
    return out


def decimal(ints_candidate, ints_baseline, divisor):
    """Decimal data written as integers over a divisor: each value correctly rounded from its integer."""
    return [k / divisor for k in ints_candidate], [k / divisor for k in ints_baseline], (ints_candidate, ints_baseline, divisor)


def datasets():
    rng = np.random.default_rng(20261023)
    normal12 = rng.normal(0.0, 1.0, 12)
    shift12 = rng.normal(0.4, 1.0, 12)
    normal20 = rng.normal(5.0, 2.0, 20)
    shift20 = rng.normal(0.3, 1.0, 20)
    uniform20 = rng.uniform(0.0, 1.0, 20)
    worse20 = rng.uniform(-0.6, 0.2, 20)

    rates = decimal([9, 10, 8, 7, 10, 9, 6, 10, 8, 9], [8, 9, 8, 9, 7, 10, 6, 9, 7, 8], 10)
    tie = decimal([1, 2, 0], [0, 0, 3], 10)
    latency = decimal(
        [30120, 29870, 31050, 30480, 29990, 30310, 30770, 29640, 30200, 30530, 30060, 30910],
        [30170, 29920, 31050, 30430, 30040, 30360, 30720, 29690, 30250, 30480, 30110, 30960],
        1000,
    )
    level = decimal(
        [30120, 29870, 31050, 30480, 29990, 30310, 30770, 29640, 30200, 30530],
        [30170, 29820, 31050, 30430, 30040, 30260, 30820, 29590, 30250, 30530],
        1000,
    )
    return [
        dataset('two-pairs', 'the fewest pairs SciPy takes', [3.0, 5.0], [1.0, 2.0]),
        dataset('three-pairs-worse', 'the candidate worse on every pair', [1.0, 0.0, 2.0], [4.0, 3.0, 2.5]),
        dataset('zeros-and-ties', 'zero differences and equal differences', [2.0, 1.0, 3.0, 0.0, 1.0, 2.0, 5.0, 4.0], [1.0, 1.0, 2.0, 1.0, 0.0, 2.0, 3.0, 4.0]),
        dataset('all-zero', 'every difference zero', [0.5, 1.0, 1.5, 2.0], [0.5, 1.0, 1.5, 2.0]),
        dataset('all-better', 'every difference positive', [11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0], [10.5, 11.0, 12.25, 12.0, 14.5, 15.0, 15.75, 17.0, 18.5, 18.0]),
        dataset('dyadic-halves', 'halves and quarters: every sum exact, ties exact', [2.5, 1.0, 3.25, 0.5, 4.0, 2.0, 1.75, 3.0, 2.5, 0.25, 1.5, 2.0], [2.0, 1.5, 2.75, 0.5, 3.0, 2.5, 1.25, 3.0, 1.5, 0.75, 1.0, 1.5]),
        dataset('rates-tenths', 'rates in tenths: decimal ties SciPy\'s tolerance catches', *rates[:2], exact=rates[2]),
        dataset('counts-twenty', 'small counts on 20 pairs: many zeros and ties', [0.0, 1.0, 0.0, 2.0, 1.0, 0.0, 0.0, 3.0, 1.0, 0.0, 2.0, 0.0, 1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 1.0], [1.0, 1.0, 0.0, 3.0, 2.0, 1.0, 0.0, 3.0, 2.0, 0.0, 2.0, 1.0, 1.0, 1.0, 0.0, 2.0, 2.0, 1.0, 0.0, 1.0]),
        dataset('normal-twelve', 'continuous draws, a moderate effect', (normal12 + shift12).tolist(), normal12.tolist()),
        dataset('normal-twenty', 'continuous draws on 20 pairs, a small effect', (normal20 + shift20).tolist(), normal20.tolist()),
        dataset('worse-twenty', 'the candidate mostly worse on 20 pairs', (uniform20 + worse20).tolist(), uniform20.tolist()),
        dataset('tolerance-tie', 'decimal differences 0.1, 0.2, -0.3 whose sum is 0 only in exact arithmetic', *tie[:2], exact=tie[2]),
        dataset('latency-seconds', 'latencies near 30 s that differ by 0.05 s: decimal ties SciPy\'s tolerance still catches', *latency[:2], exact=latency[2]),
        dataset('latency-level', 'latencies near 30 s that differ by 0.05 s, level on average: ties carried by the rounding of 30 s', *level[:2], exact=level[2]),
    ]


def collapse(text):
    """Arrays of numbers on one line, so the fixture reads as a table."""
    return re.sub(r'\[\s*([-0-9.eE+,\s]*?)\s*\]', lambda m: '[' + re.sub(r'\s*,\s*', ', ', m.group(1).strip()) + ']', text)


def main(out):
    fixture = {
        'about': 'Golden results of the exact paired sign-flip test, from SciPy (docs/design/statistics.md#golden-tests).',
        'generator': 'scripts/statistics/sign-flip-goldens.py',
        'reference': {
            'python': platform.python_version(),
            'numpy': np.__version__,
            'scipy': scipy.__version__,
            'function': 'scipy.stats.permutation_test',
            'paired': "permutation_test((candidate, baseline), lambda x, y, axis: mean(x - y, axis), permutation_type='samples', vectorized=True, n_resamples=inf, batch=16384, alternative=...)",
            'oneSample': "permutation_test((values,), lambda x, axis: mean(x, axis), permutation_type='samples', vectorized=True, n_resamples=inf, batch=16384, alternative=...)",
        },
        'confidences': CONFIDENCES,
        'datasets': datasets(),
    }
    with open(out, 'w', encoding='utf-8') as f:
        f.write(collapse(json.dumps(fixture, indent=2, allow_nan=False)) + '\n')


if __name__ == '__main__':
    main(sys.argv[1])
