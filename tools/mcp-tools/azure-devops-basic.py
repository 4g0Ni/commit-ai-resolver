from msal import PublicClientApplication
import httpx
from typing import Any, Dict, Optional
import asyncio
import os
import argparse
from azure.devops.connection import Connection
from msrest.authentication import BasicAuthentication
from azure.identity import DefaultAzureCredential, AzureCliCredential, InteractiveBrowserCredential
from azure.devops.v7_0.git.models import GitPullRequestSearchCriteria, GitPullRequest
from azure.devops.v7_0.git.git_client import GitClient
from mcp.server.fastmcp import FastMCP
from git import Repo

# Try to load .env
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("python-dotenv loaded")
except ImportError:
    print("python-dotenv not available")
    # Manual loading fallback
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    key, value = line.strip().split('=', 1)
                    os.environ[key] = value
        print("Manually loaded .env")

organization_url = "https://dev.azure.com/msasg"
TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47"
SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default"

app = PublicClientApplication(
    "9ef9190c-3c3d-45a4-a66c-5ca1f71fb67b",
    authority=f"https://login.microsoftonline.com/{TENANT_ID}")

USER_AGENT = "test-app/1.0"

# Configuration - can be overridden by environment variables or command line args
MY_CREATOR_ID = os.getenv("MCP_CREATOR_ID")

script_dir = os.path.dirname(os.path.abspath(__file__))
ADS_APP_CAMPAIGN_UI_PATH = os.path.dirname(os.path.dirname(script_dir))

# Initialize FastMCP server
mcp = FastMCP("SmartHelper")

# Global client (can be shared by handlers later)
git_client: GitClient = None
current_credential = None

def init_git_client():
    """Initialize git client without authentication - will be done via login tool"""
    global git_client
    git_client = None
    print("Git client initialized. Use login() tool to authenticate.")

@mcp.tool()
def login(method: str = "cli") -> dict:
    """
    Login to Azure DevOps using different authentication methods

    Args:
        method: Authentication method to use. Options:
               - "cli" (default): Use Azure CLI authentication
               - "browser": Use interactive browser authentication
               - "device": Use device code authentication
    """
    global git_client, current_credential

    try:
        if method == "cli":
            print("Attempting Azure CLI authentication...")
            credential = AzureCliCredential()

        elif method == "browser":
            print("Starting interactive browser authentication...")
            credential = InteractiveBrowserCredential(
                tenant_id=TENANT_ID
            )

        elif method == "device":
            print("Starting device code authentication...")
            from azure.identity import DeviceCodeCredential
            credential = DeviceCodeCredential(
                tenant_id=TENANT_ID
            )

        else:
            return {
                "success": False,
                "message": f"Unknown method '{method}'. Use 'cli', 'browser', or 'device'"
            }

        # Test the credential by getting a token
        print("Getting authentication token...")
        token = credential.get_token(SCOPE)

        # Create Azure DevOps connection
        print("Creating Azure DevOps connection...")
        creds = BasicAuthentication("", token.token)
        connection = Connection(base_url="https://dev.azure.com/msasg", creds=creds)

        # Initialize git client
        git_client = connection.clients.get_git_client()
        current_credential = credential

        # Test the connection
        repos = git_client.get_repositories(project="Bing_Ads")

        return {
            "success": True,
            "message": f"Successfully authenticated using {method} method. Found {len(repos)} repositories.",
            "method_used": method
        }

    except Exception as e:
        error_msg = str(e)
        suggestions = []

        if method == "cli":
            suggestions.append("Try running 'az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47' first")
            suggestions.append("Or try login(method='browser') for interactive authentication")
        elif "interactive" in error_msg.lower():
            suggestions.append("Try login(method='device') for device code flow")

        return {
            "success": False,
            "message": f"Authentication failed with {method} method: {error_msg}",
            "suggestions": suggestions
        }

@mcp.tool()
def check_authentication_status() -> dict:
    """
    Check current authentication status
    """
    global git_client, current_credential

    if git_client is None:
        return {
            "authenticated": False,
            "message": "Not authenticated. Use login() or login_with_pat() to authenticate."
        }

    try:
        # Test connection with a simple API call
        repos = git_client.get_repositories(project="Bing_Ads")
        return {
            "authenticated": True,
            "message": f"Successfully authenticated. Access to {len(repos)} repositories.",
            "credential_type": str(type(current_credential).__name__) if current_credential != "PAT" else "Personal Access Token"
        }
    except Exception as e:
        return {
            "authenticated": False,
            "message": f"Authentication expired or invalid: {str(e)}",
            "suggestion": "Re-run login() to refresh authentication"
        }

@mcp.tool()
def logout() -> dict:
    """
    Logout and clear authentication
    """
    global git_client, current_credential

    git_client = None
    current_credential = None

    return {
        "success": True,
        "message": "Logged out successfully. Use login() to authenticate again."
    }

# Helper function to check auth before API calls
def ensure_authenticated():
    """Helper function to check authentication before making API calls"""
    if git_client is None:
        return {
            "error": "Not authenticated. Please run login() first.",
            "suggestions": [
                "login() - for Azure CLI authentication",
                "login(method='browser') - for browser authentication",
                "login_with_pat('your-token') - for PAT authentication"
            ]
        }
    return None

@mcp.tool()
def get_configuration() -> dict:
    """
    Get current MCP server configuration
    """
    return {
        "creator_id": MY_CREATOR_ID,
        "campaign_ui_path": ADS_APP_CAMPAIGN_UI_PATH,
        "organization_url": organization_url,
        "tenant_id": TENANT_ID
    }

@mcp.tool()
def get_adsappui_repository_id():
    """ Get the repository id for ads app ui

    Args:
        None
    """
    return "6e312a53-03cc-4229-bc22-a5f89fd897bb"

@mcp.tool()
def get_adsappcampaignui_repository_id():
    """ Get the repository id for ads app campaign ui

    Args:
        None
    """
    return "0900798c-58d2-4697-b29e-1c1754a14043"

@mcp.tool()
def get_adsappscampaignui_local_path():
    """ Get the local repo path for ads apps campaign ui

    Args:
        None
    """
    return ADS_APP_CAMPAIGN_UI_PATH

@mcp.tool()
def get_pull_requests_based_on_creator_id(repository_id: str, top: int = 10, skip: int = 0):
    """ Get the Pull requests that Creator ID has made in Campaign UI

    Args:
        repository_id: the repository id for getting the PRs
        top: How many PRs to fetch
        skip: How many to skip (for paging)
    """

    # Check authentication first
    auth_check = ensure_authenticated()
    if auth_check:
        return auth_check

    try:
        search_criteria = GitPullRequestSearchCriteria(
            creator_id=MY_CREATOR_ID,
            status='completed'
        )

        # Get pull requests
        pull_requests = git_client.get_pull_requests(
            repository_id=repository_id,
            search_criteria=search_criteria,
            project="Bing_Ads",
            top=top,
            skip=skip
        )

        return pull_requests

    except Exception as e:
        if any(keyword in str(e).lower() for keyword in ['unauthorized', 'authentication', 'forbidden']):
            return {
                "error": f"Authentication failed: {e}",
                "suggestion": "Your authentication may have expired. Try running login() again."
            }
        return {"error": str(e)}

@mcp.tool()
def get_pull_requests(repository_id: str, top: int = 10, skip: int = 0):
    """ Get the Pull requests in Campaign UI

    Args:
        repository_id: the repository id for getting the PRs
        top: How many PRs to fetch
        skip: How many to skip (for paging)
    """

    # Check authentication first
    auth_check = ensure_authenticated()
    if auth_check:
        return auth_check

    try:
        search_criteria = GitPullRequestSearchCriteria(
            status='completed',
        )

        # Get pull requests
        pull_requests = git_client.get_pull_requests(
            repository_id=repository_id,
            search_criteria=search_criteria,
            project="Bing_Ads",
            top=top,
            skip=skip
        )

        return pull_requests

    except Exception as e:
        if any(keyword in str(e).lower() for keyword in ['unauthorized', 'authentication', 'forbidden']):
            return {
                "error": f"Authentication failed: {e}",
                "suggestion": "Your authentication may have expired. Try running login() again."
            }
        return {"error": str(e)}

@mcp.tool()
def get_diff_from_pr_id(pr_id: int, repository_id: str, repository_path: str) -> dict:
    """
        Get the diff for the merge commit of a completed PR using GitPython.

    Args:
        pr_id (int): The pull request ID.
        repository_id: the repository id for getting the PRs
        repository_path: repository local path
    """

    # Check authentication first
    auth_check = ensure_authenticated()
    if auth_check:
        return auth_check

    diffs = []

    repo = Repo(repository_path)

    try:
        pullrequest: GitPullRequest = git_client.get_pull_request(
                repository_id=repository_id,
                pull_request_id=pr_id,
                project="Bing_Ads"
            )

        merge_commit = pullrequest.last_merge_commit

        if not merge_commit or not merge_commit.commit_id:
            diffs.append({
                "pr_id": pullrequest.pull_request_id,
                "title": pullrequest.title,
                "error": "No merge commit available"
            })
            return diffs

        merge_sha = merge_commit.commit_id

        try:
            repo.git.fetch()  # ensure we have latest commits

            # Get the diff introduced by the merge commit
            diff = repo.git.diff(f"{merge_sha}^", merge_sha)

            diffs.append({
                "pr_id": pullrequest.pull_request_id,
                "title": pullrequest.title,
                "merge_commit": merge_sha,
                "diff": diff
            })

        except Exception as e:
            diffs.append({
                "pr_id": pullrequest.pull_request_id,
                "title": pullrequest.title,
                "merge_commit": merge_sha,
                "error": str(e)
            })

        return diffs

    except Exception as e:
        if any(keyword in str(e).lower() for keyword in ['unauthorized', 'authentication', 'forbidden']):
            return {
                "error": f"Authentication failed: {e}",
                "suggestion": "Your authentication may have expired. Try running login() again."
            }
        return {"error": str(e)}

@mcp.tool()
def create_branch_from_main(branch_name: str, repository_path: str) -> dict:
    """
        Create a branch from master to update the code

    Args:
        branch_name (str): the branch name, usually its named as {alias}/ai/{describefeature}
        repository_path: repository local path
    """
    repo = Repo(repository_path)

    try:
        repo.git.fetch()
        base_branch = "master"  # or use PR's target branch dynamically
        repo.git.checkout(base_branch)
        repo.git.pull()
        new_branch = repo.create_head(branch_name)
        new_branch.checkout()
        return {"success": True, "message": f"Created and switched to branch {branch_name}"}
    except Exception as e:
        return {"success": False, "message": str(e)}

@mcp.tool()
def push_branch_and_create_pr(repository_id: str, repository_path: str, branch_name: str, title: str, description: str, target_branch: str = "master") -> dict:
    """
        commit the changes and push the changes to azure devops

    Args:
        repository_id: the repository id for getting the PRs
        repository_path: repository local path
        branch_name (str): the branch name
        title (str): title for the PR
        description (str): describing the changes
        target_branch (str): usually the master.
    """

    # Check authentication first
    auth_check = ensure_authenticated()
    if auth_check:
        return auth_check

    repo = Repo(repository_path)

    try:
        repo.git.push("--set-upstream", "origin", branch_name)

        pull_request = GitPullRequest(
            source_ref_name=f"refs/heads/{branch_name}",
            target_ref_name=f"refs/heads/{target_branch}",
            title=title,
            description=description
        )

        pr = git_client.create_pull_request(
            git_pull_request_to_create=pull_request,
            repository_id=repository_id,
            project="Bing_Ads"
        )

        # Get repository name for URL formatting
        repo_info = git_client.get_repository(repository_id=repository_id, project="Bing_Ads")
        repo_name = repo_info.name

        # Format URL in Visual Studio style
        formatted_url = f"https://msasg.visualstudio.com/Bing_Ads/_git/{repo_name}/pullrequest/{pr.pull_request_id}"

        return {
            "success": True,
            "message": f"PR created: {pr.pull_request_id}",
            "pr_url": formatted_url,
            "pr_id": pr.pull_request_id
        }

    except Exception as e:
        if any(keyword in str(e).lower() for keyword in ['unauthorized', 'authentication', 'forbidden']):
            return {
                "error": f"Authentication failed: {e}",
                "suggestion": "Your authentication may have expired. Try running login() again."
            }
        return {"success": False, "message": str(e)}


@mcp.tool()
def get_failed_tests_from_build(
    project: str,
    build_id: int,
    include_stack_trace: bool = False,
    top: int = 10
) -> dict:
    """
    Get all failed test details from a build in a single call.

    Args:
        project: The project name (e.g., "Bing_Ads")
        build_id: The build ID (e.g., 64579051)
        include_stack_trace: Whether to include full stack traces (can be verbose)
        top: Maximum number of failed tests to return (default 10 to avoid context pollution)

    Returns:
        dict with total failed count and list of failed tests including:
        - automatedTestName: Full test name
        - errorMessage: The failure error message
        - testRunId: The test run this result belongs to
        - stackTrace: Stack trace (if include_stack_trace=True)
        - durationInMs: Test duration
    """
    auth_check = ensure_authenticated()
    if auth_check:
        return auth_check

    try:
        # Get token from credential
        token = current_credential.get_token(SCOPE)
        headers = {"Authorization": f"Bearer {token.token}"}

        # Step 1: Get all test runs for the build
        build_uri = f"vstfs:///Build/Build/{build_id}"
        runs_url = f"{organization_url}/{project}/_apis/test/runs"
        runs_params = {"buildUri": build_uri, "api-version": "7.1"}

        runs_response = httpx.get(runs_url, headers=headers, params=runs_params)
        runs_response.raise_for_status()
        runs_data = runs_response.json()
        test_runs = runs_data.get("value", [])

        if not test_runs:
            return {"count": 0, "results": [], "message": "No test runs found for this build"}

        # Step 2: Get failed results from each run
        all_failed_tests = []

        for run in test_runs:
            run_id = run.get("id")
            run_name = run.get("name", "Unknown")

            # Get failed results for this run
            results_url = f"{organization_url}/{project}/_apis/test/Runs/{run_id}/results"
            results_params = {"outcomes": "Failed", "api-version": "7.1", "$top": "1000"}

            results_response = httpx.get(results_url, headers=headers, params=results_params)
            results_response.raise_for_status()
            results_data = results_response.json()
            failed_results = results_data.get("value", [])

            for r in failed_results:
                failed_test = {
                    "id": r.get("id"),
                    "testRunId": run_id,
                    "testRunName": run_name,
                    "automatedTestName": r.get("automatedTestName"),
                    "testCaseTitle": r.get("testCaseTitle"),
                    "outcome": r.get("outcome"),
                    "errorMessage": r.get("errorMessage"),
                    "durationInMs": r.get("durationInMs"),
                    "failureType": r.get("failureType")
                }
                if include_stack_trace:
                    failed_test["stackTrace"] = r.get("stackTrace")

                all_failed_tests.append(failed_test)

        return {
            "buildId": build_id,
            "totalFailedCount": len(all_failed_tests),
            "returnedCount": min(len(all_failed_tests), top),
            "results": all_failed_tests[:top]
        }

    except httpx.HTTPStatusError as e:
        return {"error": f"HTTP {e.response.status_code}: {e.response.text}"}
    except Exception as e:
        if any(keyword in str(e).lower() for keyword in ['unauthorized', 'authentication', 'forbidden']):
            return {
                "error": f"Authentication failed: {e}",
                "suggestion": "Your authentication may have expired. Try running login() again."
            }
        return {"error": str(e)}


if __name__ == "__main__":
    # Parse command line arguments and update configuration
    try:
        parser = argparse.ArgumentParser(description='MCP Server for Azure DevOps')
        parser.add_argument('--creator-id',
                           help='Your Azure DevOps creator/user ID',
                           default=None)
        parser.add_argument('--adsappui-path',
                           help='Local path to AdsAppUI repository',
                           default=None)
        parser.add_argument('--campaign-ui-path',
                           help='Local path to Campaign UI repository',
                           default=None)

        args = parser.parse_args()

        # Update global configuration from command line arguments
        if args.creator_id:
            MY_CREATOR_ID = args.creator_id
            print(f"Using creator ID from args: {MY_CREATOR_ID}")

        if args.campaign_ui_path:
            ADS_APP_CAMPAIGN_UI_PATH = args.campaign_ui_path
            print(f"Using Campaign UI path from args: {ADS_APP_CAMPAIGN_UI_PATH}")

    except SystemExit:
        # Handle --help or invalid arguments gracefully
        pass

    print("Starting MCP Server with configuration:")
    print(f"  Creator ID: {MY_CREATOR_ID}")
    print(f"  Campaign UI Path: {ADS_APP_CAMPAIGN_UI_PATH}")

    init_git_client()
    mcp.run(transport='stdio')