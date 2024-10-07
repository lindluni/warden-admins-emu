import core from '@actions/core'
import {Octokit} from "@octokit/rest"
import {retry} from "@octokit/plugin-retry"
import {throttling} from "@octokit/plugin-throttling"

const _Octokit = Octokit.plugin(retry, throttling)

async function newClient (token) {
    return new _Octokit({
        auth: token,
        retries: 10,
        throttle: {
            onRateLimit: (retryAfter, options, octokit) => {
                octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
                if (options.request.retryCount === 0) {
                    octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onSecondaryRateLimit: (retryAfter, options, octokit) => {
                octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`);
                if (options.request.retryCount === 0) {
                    octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
        }
    });
}

async function sendComment(client, org, repo, issueNumber, body) {
    core.info(`Sending comment to ${org}/${repo}#${issueNumber}`)
    await client.issues.createComment({
        owner: org,
        repo: repo,
        issue_number: issueNumber,
        body: body
    })
}

async function main() {
    const actor = core.getInput('actor', {required: true, trimWhitespace: true})
    const adminToken = core.getInput('admin_token', {required: true, trimWhitespace: true})
    const _body = core.getInput('body', {required: true, trimWhitespace: true}).trim().split(' ')
    const closeIssue = core.getInput('close_issue', {required: true, trimWhitespace: true}) === 'true'
    const issueNumber = core.getInput('issue_number', {required: true, trimWhitespace: true})
    const issueOrg = core.getInput('issue_org', {required: true, trimWhitespace: true})
    const org = core.getInput('org', {required: true, trimWhitespace: true})
    const repo = core.getInput('repo', {required: true, trimWhitespace: true})
    const githubToken = core.getInput('token', {required: true, trimWhitespace: true})
    const queryRepo = _body[_body.length - 1]

    const client = await newClient(adminToken)
    const commentClient = await newClient(githubToken)

    try {
        core.info(`Verifying repository ${org}/${queryRepo} exists`)
        await client.repos.get({
            owner: org,
            repo: queryRepo
        })
    } catch (e) {
        if(e.status === 404) {
            await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere was an error retrieving the direct admins for \`${repo}\`:\n\nThe repository \`${org}/${queryRepo}\` does not exist in the target organization \`${org}\`.\n\nEnsure you've provided the correct organization and repository name.`)
            return
        }
        await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere was an error verifying the repository ${queryRepo} exists:\n\n${e.message}`)
        core.setFailed(e.message)
    }

    let members
    try {
        core.info(`Retrieving direct admins for ${org}/${queryRepo}`)
        members = await client.paginate(client.repos.listCollaborators, {
            owner: org,
            repo: queryRepo,
            affiliation: 'direct',
            per_page: 100
        })
    } catch (e) {
        await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere was an error retrieving the direct admins for \`${org}/${repo}\`:\n\n${e.message}`)
        core.setFailed(e.message)
    }

    const admins = members.filter(member => member.permissions.admin).map(member => member.login)

    let teams
    try {
        core.info(`Retrieving teams for ${org}/${repo}`)
        teams = await client.paginate(client.repos.listTeams, {
            owner: org,
            repo: queryRepo,
        })
    } catch (e) {
        await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere was an error retrieving the teams for \`${org}/${repo}\`:\n\n${e.message}`)
        core.setFailed(e.message)
    }

    const adminTeams = teams.filter(t => t.permission === 'admin')
    for (const team of adminTeams) {
        try {
            core.info(`Retrieving members for ${team.name}`)
            const members = await client.paginate(client.teams.listMembersInOrg, {
                org: org,
                team_slug: team.slug,
                per_page: 100
            })
            for (const member of members) {
                if (!admins.includes(member.login)) {
                    admins.push(member.login)
                }
            }
        } catch (e) {
            await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere was an error retrieving the members for ${team.name}:\n\n${e.message}`)
            core.setFailed(e.message)
        }
    }

    if(admins.length === 0) {
        await sendComment(commentClient, issueOrg, repo, issueNumber,`@${actor}\n\nThere are no admins for ${queryRepo}`)
        core.setFailed(`There are no admins for ${queryRepo}`)
    } else {
        let body = `The following users have been identified as having \`administrator\` access to https://github.com/${org}/${queryRepo}:\n\n`
        for (const admin of admins) {
            core.info(`Retrieving email for ${admin}`)
            const {data: user} = await client.users.getByUsername({
                username: admin
            })
            body += `- ${user.email}\n`
        }
        await sendComment(commentClient, issueOrg, repo, issueNumber, body)
    }

    if (closeIssue) {
        await commentClient.issues.update({
            owner: issueOrg,
            repo: repo,
            issue_number: issueNumber,
            state: 'closed'
        })
    }
}

main()
