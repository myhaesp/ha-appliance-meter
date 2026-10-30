# First private push preparation

Repository: MyHAEsp/ha-appliance-meter

This candidate contains a single fresh root commit with neutral contributor
identity. Historical development commits, local migration notes, environments,
caches, and installation backups are excluded. Local development history and
working installations are preserved separately.

The origin remote uses the approved github-myhaesp SSH alias. Do not push
until the owner reviews and approves the complete publication tree and history.
Verify the destination repository is PRIVATE and empty immediately before
the first push. If it contains existing branches or tags, stop and review;
never force-push or mirror the development repository. Push only main.

A local pre-push hook blocks pushes until .git/PUBLICATION_APPROVED exists.
Create that marker only after explicit approval; it is not committed.

License, copyright holder, and individual maintainer handle remain pending.
No open-source license is granted by this preparation. Private publication
does not authorize making the repository public, creating releases, or HACS
submission. No Home Assistant deployment, reload, or restart is authorized.
