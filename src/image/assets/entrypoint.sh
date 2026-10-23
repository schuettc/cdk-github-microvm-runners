#!/usr/bin/env bash
# Every job inherits this process's open-files limit (agent -> sudo -> runner),
# and the default is 1024 soft and hard, so a job cannot raise it: a Java test
# server hit "Too many open files" here. GitHub-hosted runners give 65536.
# sudo's pam_limits leaves it as is (limits.conf sets nothing). If it cannot be
# raised, stop: the agent never answers /ready and the image build fails.
ulimit -n 65536 || exit 1
exec node /opt/microvm-runner/agent.mjs
