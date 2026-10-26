# Lessons of this repository

Mistakes made in this repository before, each on one line with the check or test that now enforces
it. The brief of every run on a writing Worker carries these lines, as committed at the HEAD of the
Worker's repository, in a section named "Lessons of this repository" (T220): the lines that start
with `- `, at most 30, each cut at 400 characters. Nothing else in this file reaches a brief, and an
uncommitted edit of it reaches none. Commit it as `docs/engineering/lessons.md`.

To add a lesson, the lead or a review adds one line below and commits it: what went wrong, how to
avoid it, the task it came from, and `Check:` with what enforces it now (a check, a test, or, until
one exists, the review). Keep at most 30 lessons of at most 400 characters each; fold or drop an old
one, once a check makes it impossible to repeat, rather than add a 31st.
