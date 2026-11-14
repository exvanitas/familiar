//! Where a connection may go, at the moment it's made. A name's answers are all of the saved
//! address's reach, or the connection uses none of them: one loopback or private answer among
//! public ones is a rebinding attempt, not noise to filter out. See "5c. The guarded fetch".

use crate::address::{class_ip, IpClass, Reach};
use std::net::IpAddr;

/// The answers to connect to, if every one is of `reach` and there is at least one.
pub fn all_of(reach: Reach, answers: &[IpAddr]) -> Option<Vec<IpAddr>> {
    (!answers.is_empty() && answers.iter().all(|ip| class_ip(*ip) == IpClass::Reach(reach))).then(|| answers.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ips(v: &[&str]) -> Vec<IpAddr> {
        v.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn only_a_set_wholly_of_the_reach_is_used() {
        assert_eq!(all_of(Reach::Public, &ips(&["8.8.8.8", "1.1.1.1"])), Some(ips(&["8.8.8.8", "1.1.1.1"])));
        assert_eq!(all_of(Reach::Loopback, &ips(&["127.0.0.1", "::1"])), Some(ips(&["127.0.0.1", "::1"])));
        assert_eq!(all_of(Reach::Lan, &ips(&["10.1.2.3"])), Some(ips(&["10.1.2.3"])));
    }

    #[test]
    fn a_mixed_set_is_refused_whole() {
        assert_eq!(all_of(Reach::Public, &ips(&["8.8.8.8", "127.0.0.1"])), None, "public plus loopback");
        assert_eq!(all_of(Reach::Lan, &ips(&["10.1.2.3", "127.0.0.1"])), None, "lan plus loopback");
        assert_eq!(all_of(Reach::Public, &ips(&["8.8.8.8", "169.254.169.254"])), None, "a refused range");
        assert_eq!(all_of(Reach::Public, &[]), None, "no answers");
        assert_eq!(all_of(Reach::Public, &ips(&["::ffff:127.0.0.1"])), None, "a mapped loopback");
    }
}
