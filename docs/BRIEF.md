# The brief, verbatim

What the publication's writers asked for, quoted exactly, kept in one file so the site can
map each part to where it is answered rather than paraphrasing the request.

## The request

> - Per-stage timing output from print_timing_info() across several runs, with hardware and
>   video parameters noted.
> - LSE-C values added to the existing LSE-D harness (he mentioned this is a quick add).
> - One or two before/after comparisons for a specific optimization, with numbers.
>
> For Article 1, this would mean running the current production pipeline on an open dataset
> like HDTF, capturing per-stage timings from print_timing_info() and computing LSE-D/LSE-C
> on the outputs. One session on your existing setup is enough for a minimal empirical
> section.

## Reading the request

Four deliverables, not three: the closing paragraph adds the open-dataset run as a distinct
item. They are numbered 1 to 4 throughout the site in the order above.

One premise in the request is mistaken, and the site says so where it answers item 2: LSE-C
was not a pending addition. It has been computed on every release since March 2025 and
comes from the same SyncNet forward pass as LSE-D, so there was nothing to add. That is a
stronger position than the request assumes, not a weaker one.
